import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const serialIndex = args.indexOf("--serial");
const serial = serialIndex >= 0 ? args.splice(serialIndex, 2)[1] : undefined;
const command = args.shift();
const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
const sdk =
	process.env.ANDROID_HOME ??
	process.env.ANDROID_SDK_ROOT ??
	resolve(home, "AppData/Local/Android/Sdk");
const executable = (name) =>
	process.platform === "win32" ? `${name}.exe` : name;
const adb = existsSync(resolve(sdk, "platform-tools", executable("adb")))
	? resolve(sdk, "platform-tools", executable("adb"))
	: executable("adb");
const emulator = existsSync(resolve(sdk, "emulator", executable("emulator")))
	? resolve(sdk, "emulator", executable("emulator"))
	: executable("emulator");
const adbPrefix = serial ? ["-s", serial] : [];

function run(file, runArgs, options = {}) {
	const result = spawnSync(file, runArgs, {
		encoding: options.binary ? undefined : "utf8",
		maxBuffer: 32 * 1024 * 1024,
		stdio: options.stdio ?? "pipe"
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		process.stderr.write(result.stderr ?? "");
		process.exit(result.status ?? 1);
	}
	return result.stdout;
}

function runAdb(runArgs, options) {
	return run(adb, [...adbPrefix, ...runArgs], options);
}

function required(value, usage) {
	if (value == null) {
		console.error(`Usage: ${usage}`);
		process.exit(2);
	}
	return value;
}

function outputPath(value) {
	const path = resolve(required(value, `${command} <output>`));
	mkdirSync(dirname(path), { recursive: true });
	return path;
}

const help = `Android live test

  status                         List devices, size, density, and foreground app
  boot [avd]                     Start an emulator instance (prints its serial; safe to run in parallel)
  pair <host:port> <code>        Pair a physical phone for wireless debugging
  connect <host:port>            Connect to a paired physical phone
  screenshot <output.png>        Capture the current screen
  dump <output.xml>              Save the accessibility/UI hierarchy
  tap <x> <y>                    Tap screen coordinates
  swipe <x1> <y1> <x2> <y2> [ms] Swipe or drag
  text <value>                   Type text into the focused field
  key <name|code>                Send BACK, HOME, ENTER, POWER, or a key code
  rotate <0|90|180|270>          Set and freeze display rotation
  open-url <url>                 Open an Android deep link or web URL
  start <package> [activity]     Start an app (activity optional)
  stop <package>                 Force-stop an app
  logcat [lines]                 Print recent logs (default 400 lines)
  record <output.mp4> [seconds]  Record the screen (default 15, max 180)

Add --serial <serial> (or set ANDROID_SERIAL) to any command when multiple devices are connected.`;

switch (command) {
	case "status": {
		const devices = run(adb, ["devices", "-l"]);
		process.stdout.write(devices);
		const attached =
			devices.match(/^\S+\s+(device|offline|unauthorized)/gm) ?? [];
		if (!serial && !process.env.ANDROID_SERIAL && attached.length > 1) {
			console.log("Multiple devices attached; pass --serial for details.");
			break;
		}
		try {
			process.stdout.write(runAdb(["shell", "wm", "size"]));
			process.stdout.write(runAdb(["shell", "wm", "density"]));
			process.stdout.write(
				runAdb(["shell", "dumpsys", "activity", "activities"])
					.split("\n")
					.filter((line) => line.includes("mResumedActivity"))
					.join("\n") + "\n"
			);
		} catch {
			// A device can be listed before its shell is ready.
		}
		break;
	}
	case "boot": {
		const avds = run(emulator, ["-list-avds"])
			.trim()
			.split(/\r?\n/)
			.filter(Boolean);
		const avd = args[0] ?? avds[0];
		required(avd, "boot [avd]");
		const used = run(adb, ["devices"]);
		const free = [];
		for (let port = 5554; port <= 5584; port += 2)
			if (!used.includes(`emulator-${port}`)) free.push(port);
		// ponytail: racy free-port scan; on a collision the emulator exits loudly - rerun boot
		const port = free[Math.floor(Math.random() * free.length)];
		required(port, "boot [avd] (no free emulator port)");
		const child = spawn(
			emulator,
			["-avd", avd, "-port", String(port), "-read-only", "-no-snapshot-save"],
			{ detached: true, stdio: "ignore", windowsHide: true }
		);
		child.unref();
		console.log(
			`Started ${avd} as emulator-${port}. Pass --serial emulator-${port} to later commands; run status until it reports device.`
		);
		break;
	}
	case "pair":
		process.stdout.write(
			run(adb, [
				"pair",
				required(args[0], "pair <host:port> <code>"),
				required(args[1], "pair <host:port> <code>")
			])
		);
		break;
	case "connect":
		process.stdout.write(
			run(adb, ["connect", required(args[0], "connect <host:port>")])
		);
		break;
	case "screenshot":
		writeFileSync(
			outputPath(args[0]),
			runAdb(["exec-out", "screencap", "-p"], { binary: true })
		);
		break;
	case "dump": {
		const path = outputPath(args[0]);
		const device = `/sdcard/composery-dump-${process.pid}.xml`;
		runAdb(["shell", "uiautomator", "dump", device]);
		writeFileSync(path, runAdb(["exec-out", "cat", device], { binary: true }));
		runAdb(["shell", "rm", device]);
		break;
	}
	case "tap":
		runAdb([
			"shell",
			"input",
			"tap",
			required(args[0], "tap <x> <y>"),
			required(args[1], "tap <x> <y>")
		]);
		break;
	case "swipe":
		runAdb(["shell", "input", "swipe", ...args.slice(0, 5)]);
		break;
	case "text":
		runAdb([
			"shell",
			"input",
			"text",
			required(args.join(" "), "text <value>").replaceAll(" ", "%s")
		]);
		break;
	case "key":
		runAdb([
			"shell",
			"input",
			"keyevent",
			required(args[0], "key <name|code>")
		]);
		break;
	case "rotate": {
		const degrees = required(args[0], "rotate <0|90|180|270>");
		const value = { 0: "0", 90: "1", 180: "2", 270: "3" }[degrees];
		required(value, "rotate <0|90|180|270>");
		runAdb([
			"shell",
			"settings",
			"put",
			"system",
			"accelerometer_rotation",
			"0"
		]);
		runAdb(["shell", "settings", "put", "system", "user_rotation", value]);
		break;
	}
	case "open-url":
		runAdb(
			[
				"shell",
				"am",
				"start",
				"-a",
				"android.intent.action.VIEW",
				"-d",
				required(args[0], "open-url <url>")
			],
			{ stdio: "inherit" }
		);
		break;
	case "start": {
		const pkg = required(args[0], "start <package> [activity]");
		const startArgs = args[1]
			? ["shell", "am", "start", "-n", `${pkg}/${args[1]}`]
			: [
					"shell",
					"monkey",
					"-p",
					pkg,
					"-c",
					"android.intent.category.LAUNCHER",
					"1"
				];
		runAdb(startArgs, { stdio: "inherit" });
		break;
	}
	case "stop":
		runAdb(["shell", "am", "force-stop", required(args[0], "stop <package>")]);
		break;
	case "logcat":
		process.stdout.write(runAdb(["logcat", "-d", "-t", args[0] ?? "400"]));
		break;
	case "record": {
		const path = outputPath(args[0]);
		const seconds = String(Math.min(Number(args[1] ?? 15), 180));
		const device = `/sdcard/composery-record-${process.pid}.mp4`;
		runAdb(["shell", "screenrecord", "--time-limit", seconds, device], {
			stdio: "inherit"
		});
		writeFileSync(path, runAdb(["exec-out", "cat", device], { binary: true }));
		runAdb(["shell", "rm", device]);
		break;
	}
	default:
		console.log(help);
}
