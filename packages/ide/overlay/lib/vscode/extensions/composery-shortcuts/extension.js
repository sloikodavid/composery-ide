const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { TextDecoder, TextEncoder } = require("node:util");
const vscode = require("vscode");

const STORAGE_FILE_NAME = "shortcuts.json";
const STORAGE_VERSION = 1;
const DEFAULT_ICON = "terminal";
const VIEW_ID = "composery.shortcuts.view";
const TREE_MIME = `application/vnd.code.tree.${VIEW_ID}`;

const RUN_COMMAND = "composery.shortcuts.run";
const ADD_COMMAND = "composery.shortcuts.add";
const EDIT_COMMAND = "composery.shortcuts.edit";
const DUPLICATE_COMMAND = "composery.shortcuts.duplicate";
const REMOVE_COMMAND = "composery.shortcuts.remove";
const MOVE_UP_COMMAND = "composery.shortcuts.moveUp";
const MOVE_DOWN_COMMAND = "composery.shortcuts.moveDown";
const REFRESH_COMMAND = "composery.shortcuts.refresh";
const UNDO_REMOVE_COMMAND = "composery.shortcuts.undoRemove";
const CAN_UNDO_REMOVE_CONTEXT = "composery.shortcuts.canUndoRemove";

const INTERNAL_PICK_ICON_COMMAND = "composery.shortcuts.pickIcon";
const INTERNAL_PICK_COLOR_COMMAND = "composery.shortcuts.pickColor";
const INTERNAL_RESOLVE_VARIABLES_COMMAND = "composery.shortcuts.resolveVariables";

const BACK = Symbol("back");

let shortcuts = [];
let lastRemoved;

async function activate(context) {
	const allCommands = new Set(await vscode.commands.getCommands(false));
	const missing = [
		INTERNAL_PICK_ICON_COMMAND,
		INTERNAL_PICK_COLOR_COMMAND,
		INTERNAL_RESOLVE_VARIABLES_COMMAND
	].filter((id) => !allCommands.has(id));
	if (missing.length > 0) {
		console.error(
			`[composery-shortcuts] missing patched workbench commands: ${missing.join(", ")}. ` +
				"Rebuild Composery with up-to-date patches and clear the browser cache."
		);
	}

	const storage = new ShortcutStorage(context);
	const tree = new ShortcutsTreeDataProvider();
	const view = vscode.window.createTreeView(VIEW_ID, {
		treeDataProvider: tree,
		dragAndDropController: new ShortcutsDragAndDropController(
			() => shortcuts,
			async (nextShortcuts) => {
				await save(nextShortcuts);
			}
		),
		showCollapseAll: false
	});

	async function load() {
		lastRemoved = undefined;
		await vscode.commands.executeCommand("setContext", CAN_UNDO_REMOVE_CONTEXT, false);
		shortcuts = await storage.read();
		tree.setShortcuts(shortcuts);
	}

	async function save(nextShortcuts) {
		lastRemoved = undefined;
		await vscode.commands.executeCommand("setContext", CAN_UNDO_REMOVE_CONTEXT, false);
		shortcuts = nextShortcuts;
		await storage.write(shortcuts);
		tree.setShortcuts(shortcuts);
	}

	context.subscriptions.push(
		view,
		vscode.commands.registerCommand(REFRESH_COMMAND, load),
		vscode.commands.registerCommand(ADD_COMMAND, async () => {
			const created = await editShortcut();
			if (created) {
				await save([...shortcuts, created]);
			}
		}),
		vscode.commands.registerCommand(RUN_COMMAND, async (item) => {
			const shortcut = await resolveShortcutArgument(item);
			if (shortcut) {
				await runShortcut(shortcut);
			}
		}),
		vscode.commands.registerCommand(EDIT_COMMAND, async (item) => {
			const shortcut = await resolveShortcutArgument(item);
			if (!shortcut) return;
			const edited = await editShortcut(shortcut);
			if (edited) {
				await save(shortcuts.map((candidate) => (candidate.id === edited.id ? edited : candidate)));
			}
		}),
		vscode.commands.registerCommand(DUPLICATE_COMMAND, async (item) => {
			const shortcut = await resolveShortcutArgument(item);
			if (!shortcut) return;
			const now = new Date().toISOString();
			await save([
				...shortcuts,
				{
					...shortcut,
					id: randomUUID(),
					label: `${shortcut.label} Copy`,
					createdAt: now,
					updatedAt: now
				}
			]);
		}),
		vscode.commands.registerCommand(REMOVE_COMMAND, async (item) => {
			const shortcut = await resolveShortcutArgument(item);
			if (!shortcut) return;
			const answer = await vscode.window.showWarningMessage(
				`Remove shortcut '${shortcut.label}'?`,
				{
					modal: true,
					detail:
						shortcut.type === "file" || shortcut.type === "folder"
							? "The original file or folder will not be removed."
							: undefined
				},
				"Remove"
			);
			if (answer === "Remove") {
				const index = shortcuts.findIndex((candidate) => candidate.id === shortcut.id);
				await save(shortcuts.filter((candidate) => candidate.id !== shortcut.id));
				lastRemoved = { shortcut, index: Math.max(index, 0) };
				await vscode.commands.executeCommand("setContext", CAN_UNDO_REMOVE_CONTEXT, true);
			}
		}),
		vscode.commands.registerCommand(UNDO_REMOVE_COMMAND, async () => {
			await restoreLastRemoved(save);
		}),
		vscode.commands.registerCommand(MOVE_UP_COMMAND, async (item) => {
			const shortcut = await resolveShortcutArgument(item);
			if (shortcut) {
				await move(shortcut, -1, save);
			}
		}),
		vscode.commands.registerCommand(MOVE_DOWN_COMMAND, async (item) => {
			const shortcut = await resolveShortcutArgument(item);
			if (shortcut) {
				await move(shortcut, 1, save);
			}
		})
	);

	await load();
}

function deactivate() {}

class ShortcutStorage {
	constructor(context) {
		this.context = context;
		this.storageUri = vscode.Uri.joinPath(context.globalStorageUri, STORAGE_FILE_NAME);
		this.tempUri = vscode.Uri.joinPath(context.globalStorageUri, `${STORAGE_FILE_NAME}.tmp`);
		this.backupUri = vscode.Uri.joinPath(context.globalStorageUri, `${STORAGE_FILE_NAME}.bak`);
	}

	async read() {
		await vscode.workspace.fs.createDirectory(this.context.globalStorageUri);

		let bytes;
		try {
			bytes = await vscode.workspace.fs.readFile(this.storageUri);
		} catch (error) {
			if (isFileNotFound(error)) {
				return defaultShortcuts();
			}
			throw error;
		}

		try {
			const parsed = JSON.parse(new TextDecoder().decode(bytes));
			if (parsed.version === STORAGE_VERSION && Array.isArray(parsed.shortcuts)) {
				return parsed.shortcuts.map(normalizeShortcut).filter(isRunnableShortcut);
			}
		} catch {
		}

		await this.backup(bytes);
		return [];
	}

	async backup(bytes) {
		try {
			await vscode.workspace.fs.writeFile(this.backupUri, bytes);
		} catch {
		}
	}

	async write(nextShortcuts) {
		await vscode.workspace.fs.createDirectory(this.context.globalStorageUri);
		const payload = {
			version: STORAGE_VERSION,
			shortcuts: nextShortcuts.map(normalizeShortcut)
		};
		const bytes = new TextEncoder().encode(`${JSON.stringify(payload, null, "\t")}\n`);
		await vscode.workspace.fs.writeFile(this.tempUri, bytes);
		await vscode.workspace.fs.rename(this.tempUri, this.storageUri, { overwrite: true });
	}
}

function defaultShortcuts() {
	const volumeRoot = process.env.COMPOSERY_DOCKER_VOLUME_PATH?.trim() || "/data";
	const now = new Date().toISOString();
	return [
		{
			id: "persistence-config",
			type: "file",
			label: "config.json",
			file: vscode.Uri.file(path.posix.join(volumeRoot, "persistence", "config.json")).toString(),
			createdAt: now,
			updatedAt: now
		}
	];
}

class ShortcutTreeItem extends vscode.TreeItem {
	constructor(shortcut) {
		super(shortcut.label, vscode.TreeItemCollapsibleState.None);
		this.shortcut = shortcut;
		this.tooltip = shortcutTooltip(shortcut);

		const resourceUri = resourceUriForShortcut(shortcut);
		if (shortcut.type === "file" && resourceUri) {
			this.iconPath = vscode.ThemeIcon.File;
			this.resourceUri = resourceUri;
			this.description = displayDirname(resourceUri);
		} else if (shortcut.type === "folder" && resourceUri) {
			this.iconPath = vscode.ThemeIcon.Folder;
			this.resourceUri = resourceUri;
			this.description = displayDirname(resourceUri);
		} else {
			this.iconPath = new vscode.ThemeIcon(
				shortcut.icon || DEFAULT_ICON,
				shortcut.color ? new vscode.ThemeColor(shortcut.color) : undefined
			);
			this.description = shortcut.command;
		}

		this.command = {
			command: RUN_COMMAND,
			title: "Run Shortcut",
			arguments: [this]
		};
	}
}

class ShortcutsTreeDataProvider {
	constructor() {
		this.onDidChangeTreeDataEmitter = new vscode.EventEmitter();
		this.onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
		this.shortcuts = [];
	}

	setShortcuts(nextShortcuts) {
		this.shortcuts = nextShortcuts;
		this.refresh();
	}

	refresh() {
		this.onDidChangeTreeDataEmitter.fire(undefined);
	}

	getTreeItem(element) {
		return element;
	}

	getChildren() {
		return this.shortcuts.map((shortcut) => new ShortcutTreeItem(shortcut));
	}
}

class ShortcutsDragAndDropController {
	constructor(getShortcuts, saveShortcuts) {
		this.getShortcuts = getShortcuts;
		this.saveShortcuts = saveShortcuts;
		this.dragMimeTypes = [TREE_MIME, "text/uri-list", "text/plain"];
		this.dropMimeTypes = [TREE_MIME, "text/uri-list"];
	}

	handleDrag(source, dataTransfer) {
		const draggedShortcuts = source.map((item) => item.shortcut);
		dataTransfer.set(
			TREE_MIME,
			new vscode.DataTransferItem(JSON.stringify(draggedShortcuts.map((shortcut) => shortcut.id)))
		);

		const uris = draggedShortcuts
			.map((shortcut) => resourceUriForShortcut(shortcut)?.toString())
			.filter(Boolean);
		if (uris.length > 0) {
			dataTransfer.set("text/uri-list", new vscode.DataTransferItem(uris.join("\r\n")));
		}

		const commands = draggedShortcuts
			.filter((shortcut) => shortcut.type === "terminal" && shortcut.command)
			.map((shortcut) => shortcut.command);
		if (commands.length > 0) {
			dataTransfer.set("text/plain", new vscode.DataTransferItem(commands.join("\n")));
		}
	}

	async handleDrop(target, dataTransfer) {
		const internal = dataTransfer.get(TREE_MIME);
		if (internal) {
			await this.reorder(target, await internal.asString());
			return;
		}

		const uriList = dataTransfer.get("text/uri-list");
		if (uriList) {
			await this.addResources(target, await uriList.asString());
		}
	}

	async reorder(target, value) {
		const draggedIds = parseDraggedShortcutIds(value);
		if (draggedIds.length === 0) return;

		const current = this.getShortcuts();
		const dragged = draggedIds
			.map((id) => current.find((shortcut) => shortcut.id === id))
			.filter(Boolean);
		if (dragged.length === 0) return;

		const draggedIdSet = new Set(draggedIds);
		const remaining = current.filter((shortcut) => !draggedIdSet.has(shortcut.id));
		const insertAt = dropIndex(target, remaining);
		await this.saveShortcuts([
			...remaining.slice(0, insertAt),
			...dragged,
			...remaining.slice(insertAt)
		]);
	}

	async addResources(target, uriList) {
		const now = new Date().toISOString();
		const current = this.getShortcuts();
		const created = [];
		for (const uri of parseUriList(uriList)) {
			const type = await resourceType(uri);
			const resource = uri.toString();
			if (!type) continue;
			if (hasResourceShortcut(current, type, resource)) continue;
			if (hasResourceShortcut(created, type, resource)) continue;
			created.push(fileOrFolderShortcut(type, resource, now));
		}
		if (created.length === 0) return;

		const insertAt = dropIndex(target, current);
		await this.saveShortcuts([
			...current.slice(0, insertAt),
			...created,
			...current.slice(insertAt)
		]);
	}
}

async function editShortcut(existing) {
	const now = new Date().toISOString();
	if (existing) {
		if (existing.type === "file") return editFileShortcut(existing, now);
		if (existing.type === "folder") return editFolderShortcut(existing, now);
		const edited = await editTerminalShortcut(existing, now, false);
		return edited === BACK ? undefined : edited;
	}

	while (true) {
		const type = await pickType();
		if (!type) return undefined;
		if (type === "file") {
			const file = await editFileShortcut(undefined, now);
			if (!file) continue;
			return file;
		}
		if (type === "folder") {
			const folder = await editFolderShortcut(undefined, now);
			if (!folder) continue;
			return folder;
		}
		const terminalShortcut = await editTerminalShortcut(undefined, now, true);
		if (terminalShortcut === BACK) continue;
		return terminalShortcut;
	}
}

async function editFileShortcut(existing, now) {
	const file = await pickResource("File", existing?.file, true, false);
	if (!file) return undefined;
	return {
		id: existing?.id ?? randomUUID(),
		type: "file",
		label: resourceLabel(file),
		file,
		createdAt: existing?.createdAt ?? now,
		updatedAt: now
	};
}

async function editFolderShortcut(existing, now) {
	const folder = await pickResource("Folder", existing?.folder, false, true);
	if (!folder) return undefined;
	return {
		id: existing?.id ?? randomUUID(),
		type: "folder",
		label: resourceLabel(folder),
		folder,
		createdAt: existing?.createdAt ?? now,
		updatedAt: now
	};
}

async function editTerminalShortcut(existing, now, canBackFromFirstStep) {
	const state = {
		label: existing?.label ?? "Shortcut",
		command: existing?.command ?? "",
		terminalName: existing?.terminalName ?? "",
		cwd: existing?.cwd ?? "${workspaceFolder}",
		icon: existing?.icon ?? DEFAULT_ICON,
		color: existing?.color
	};

	let step = 0;
	while (step < 5) {
		if (step === 0) {
			const value = await promptStep("Name", state.label, canBackFromFirstStep, (input) =>
				input.trim() ? undefined : "Enter a name."
			);
			if (value === undefined) return undefined;
			if (value === BACK) return BACK;
			state.label = value.trim();
			step++;
			continue;
		}

		if (step === 1) {
			const value = await promptStep("Command", state.command, true, (input) =>
				input.trim() ? undefined : "Enter a command."
			);
			if (value === undefined) return undefined;
			if (value === BACK) {
				step--;
				continue;
			}
			state.command = value.trim();
			step++;
			continue;
		}

		if (step === 2) {
			const value = await promptStep("Terminal name", state.terminalName || state.label, true);
			if (value === undefined) return undefined;
			if (value === BACK) {
				step--;
				continue;
			}
			state.terminalName = value;
			step++;
			continue;
		}

		if (step === 3) {
			const value = await promptStep("Working directory", state.cwd, true);
			if (value === undefined) return undefined;
			if (value === BACK) {
				step--;
				continue;
			}
			state.cwd = value;
			step++;
			continue;
		}

		const result = await pickAppearance(state);
		if (result === undefined) return undefined;
		if (result === BACK) {
			step--;
			continue;
		}
		break;
	}

	return {
		id: existing?.id ?? randomUUID(),
		type: "terminal",
		label: state.label,
		command: state.command,
		terminalName: optional(state.terminalName),
		cwd: optional(state.cwd),
		icon: state.icon,
		color: state.color,
		createdAt: existing?.createdAt ?? now,
		updatedAt: now
	};
}

async function pickAppearance(state) {
	while (true) {
		const action = await new Promise((resolve) => {
			const quickPick = vscode.window.createQuickPick();
			let settled = false;
			const finish = (result) => {
				if (settled) return;
				settled = true;
				resolve(result);
				quickPick.dispose();
			};
			quickPick.title = "Appearance";
			quickPick.ignoreFocusOut = true;
			quickPick.buttons = [vscode.QuickInputButtons.Back];
			quickPick.items = [
				{
					action: "icon",
					label: `$(${state.icon || DEFAULT_ICON}) Icon`,
					description: state.icon || DEFAULT_ICON
				},
				{
					action: "color",
					label: "$(symbol-color) Color",
					description: state.color ?? "Default"
				},
				{ label: "", kind: vscode.QuickPickItemKind.Separator },
				{ action: "save", label: "$(check) Save shortcut" }
			];
			quickPick.onDidTriggerButton((button) => {
				if (button === vscode.QuickInputButtons.Back) finish(BACK);
			});
			quickPick.onDidAccept(() => finish(quickPick.selectedItems[0]?.action));
			quickPick.onDidHide(() => finish(undefined));
			quickPick.show();
		});

		if (action === BACK || action === undefined) return action;
		if (action === "save") return "save";
		if (action === "icon") {
			const picked = await pickTerminalIcon();
			if (picked) {
				state.icon = picked.id;
				if (picked.color) state.color = picked.color;
			}
		} else if (action === "color") {
			const picked = await pickTerminalColor(state.color);
			if (picked !== undefined) state.color = optional(picked);
		}
	}
}

async function pickTerminalIcon() {
	try {
		const picked = await vscode.commands.executeCommand(INTERNAL_PICK_ICON_COMMAND);
		if (!picked?.id) return undefined;
		return { id: picked.id || DEFAULT_ICON, color: picked.color };
	} catch (error) {
		void vscode.window.showErrorMessage(
			`Unable to start the native terminal icon picker: ${errorMessage(error)}`
		);
		return undefined;
	}
}

async function pickTerminalColor(current) {
	try {
		return await vscode.commands.executeCommand(INTERNAL_PICK_COLOR_COMMAND, current ?? "");
	} catch (error) {
		void vscode.window.showErrorMessage(
			`Unable to start the native terminal color picker: ${errorMessage(error)}`
		);
		return undefined;
	}
}

async function pickType() {
	const items = [
		{
			shortcutType: "file",
			label: "$(file) File",
			description: "Open a file"
		},
		{
			shortcutType: "folder",
			label: "$(folder) Folder",
			description: "Open a folder"
		},
		{
			shortcutType: "terminal",
			label: "$(terminal) Terminal",
			description: "Run a terminal command"
		}
	];
	const picked = await vscode.window.showQuickPick(items, {
		title: "Add Shortcut",
		placeHolder: "Select shortcut type",
		ignoreFocusOut: true
	});
	return picked?.shortcutType;
}

async function pickResource(title, current, canSelectFiles, canSelectFolders) {
	const picked = await vscode.window.showOpenDialog({
		title,
		canSelectFiles,
		canSelectFolders,
		canSelectMany: false,
		defaultUri: current ? vscode.Uri.parse(current) : undefined
	});
	return picked?.[0]?.toString();
}

async function promptStep(title, value, canBack, validateInput) {
	return new Promise((resolve) => {
		const input = vscode.window.createInputBox();
		let settled = false;
		const finish = (result) => {
			if (settled) return;
			settled = true;
			resolve(result);
			input.dispose();
		};
		input.title = title;
		input.value = value;
		input.ignoreFocusOut = true;
		input.buttons = canBack ? [vscode.QuickInputButtons.Back] : [];
		input.onDidTriggerButton((button) => {
			if (button === vscode.QuickInputButtons.Back) finish(BACK);
		});
		input.onDidAccept(() => {
			const validation = validateInput?.(input.value);
			if (validation) {
				input.validationMessage = validation;
				return;
			}
			finish(input.value);
		});
		input.onDidHide(() => finish(undefined));
		input.show();
	});
}

async function runShortcut(shortcut) {
	if (shortcut.type === "file") {
		if (shortcut.file) {
			await vscode.commands.executeCommand("vscode.open", vscode.Uri.parse(shortcut.file));
		}
		return;
	}

	if (shortcut.type === "folder") {
		if (shortcut.folder) {
			await openFolderShortcut(vscode.Uri.parse(shortcut.folder));
		}
		return;
	}

	if (!shortcut.command) return;

	const resolvedCommand = await resolveVariables(shortcut.command);
	const terminalName = shortcut.terminalName ? await resolveVariables(shortcut.terminalName) : "";
	const cwd = shortcut.cwd ? await resolveVariables(shortcut.cwd) : undefined;
	const color = shortcut.color ? new vscode.ThemeColor(shortcut.color) : undefined;
	const terminal = vscode.window.createTerminal({
		name: terminalName || shortcut.label,
		cwd,
		iconPath: new vscode.ThemeIcon(shortcut.icon || DEFAULT_ICON, color),
		color
	});

	terminal.sendText(resolvedCommand);
	terminal.show();
}

async function openFolderShortcut(folder) {
	const answer = await vscode.window.showWarningMessage(
		`Open folder '${path.basename(folder.fsPath || folder.path)}'?`,
		{ modal: true, detail: "Open replaces this window. Add to Workspace keeps it." },
		"Open",
		"Add to Workspace"
	);
	if (answer === "Open") {
		await vscode.commands.executeCommand("vscode.openFolder", folder, { forceNewWindow: false });
		return;
	}
	if (answer === "Add to Workspace") {
		const existing = vscode.workspace.workspaceFolders ?? [];
		if (existing.some((entry) => entry.uri.toString() === folder.toString())) return;
		vscode.workspace.updateWorkspaceFolders(existing.length, 0, { uri: folder });
	}
}

async function resolveShortcutArgument(item) {
	if (item?.shortcut) {
		return item.shortcut;
	}

	const picked = await vscode.window.showQuickPick(
		shortcuts.map((shortcut) => ({
			label: shortcut.label,
			description:
				shortcut.type === "file"
					? shortcut.file
					: shortcut.type === "folder"
						? shortcut.folder
						: shortcut.command,
			shortcut
		})),
		{ title: "Shortcut", ignoreFocusOut: true }
	);
	return picked?.shortcut;
}

async function restoreLastRemoved(save) {
	if (!lastRemoved) return;
	const { shortcut, index } = lastRemoved;
	lastRemoved = undefined;
	if (shortcuts.some((candidate) => candidate.id === shortcut.id)) return;
	await save([...shortcuts.slice(0, index), shortcut, ...shortcuts.slice(index)]);
}

async function move(shortcut, direction, save) {
	const index = shortcuts.findIndex((candidate) => candidate.id === shortcut.id);
	const nextIndex = index + direction;
	if (index < 0 || nextIndex < 0 || nextIndex >= shortcuts.length) {
		return;
	}

	const nextShortcuts = [...shortcuts];
	const current = nextShortcuts[index];
	const next = nextShortcuts[nextIndex];
	if (!current || !next) {
		return;
	}
	nextShortcuts[index] = next;
	nextShortcuts[nextIndex] = current;
	await save(nextShortcuts);
}

async function resolveVariables(value) {
	try {
		return await vscode.commands.executeCommand(INTERNAL_RESOLVE_VARIABLES_COMMAND, value);
	} catch {
		return resolveVariablesFallback(value);
	}
}

function normalizeShortcut(shortcut) {
	const now = new Date().toISOString();
	const type = shortcut.type ?? "terminal";
	const file = optional(shortcut.file);
	const folder = optional(shortcut.folder);
	const resource = type === "folder" ? folder : file;
	return {
		id: shortcut.id || randomUUID(),
		type,
		label: type === "terminal" ? shortcut.label?.trim() || "Shortcut" : resourceLabel(resource),
		command: type === "terminal" ? optional(shortcut.command) : undefined,
		file: type === "file" ? file : undefined,
		folder: type === "folder" ? folder : undefined,
		terminalName: type === "terminal" ? optional(shortcut.terminalName) : undefined,
		cwd: type === "terminal" ? optional(shortcut.cwd) : undefined,
		icon: type === "terminal" ? (optional(shortcut.icon) ?? DEFAULT_ICON) : undefined,
		color: type === "terminal" ? optional(shortcut.color) : undefined,
		createdAt: shortcut.createdAt || now,
		updatedAt: shortcut.updatedAt || now
	};
}

function isRunnableShortcut(shortcut) {
	if (shortcut.type === "file") return Boolean(shortcut.file);
	if (shortcut.type === "folder") return Boolean(shortcut.folder);
	return Boolean(shortcut.command);
}

function resourceUriForShortcut(shortcut) {
	if (shortcut.type === "file" && shortcut.file) return vscode.Uri.parse(shortcut.file);
	if (shortcut.type === "folder" && shortcut.folder) return vscode.Uri.parse(shortcut.folder);
	return undefined;
}

function fileOrFolderShortcut(type, resource, now) {
	return {
		id: randomUUID(),
		type,
		label: resourceLabel(resource),
		[type]: resource,
		createdAt: now,
		updatedAt: now
	};
}

function hasResourceShortcut(list, type, resource) {
	return list.some(
		(shortcut) => shortcut.type === type && (type === "file" ? shortcut.file : shortcut.folder) === resource
	);
}

async function resourceType(uri) {
	try {
		const stat = await vscode.workspace.fs.stat(uri);
		if (stat.type & vscode.FileType.Directory) return "folder";
		if (stat.type & vscode.FileType.File) return "file";
		return undefined;
	} catch {
		return undefined;
	}
}

function parseUriList(value) {
	const uris = [];
	for (const line of value.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		try {
			uris.push(vscode.Uri.parse(trimmed, true));
		} catch {
		}
	}
	return uris;
}

function dropIndex(target, list) {
	if (!target) return list.length;
	const index = list.findIndex((shortcut) => shortcut.id === target.shortcut.id);
	return index < 0 ? list.length : index;
}

function shortcutTooltip(shortcut) {
	const value = new vscode.MarkdownString();
	value.isTrusted = false;
	value.appendMarkdown(`**${escapeMarkdown(shortcut.label)}**\n\n`);
	if (shortcut.type === "file") {
		value.appendMarkdown(`file: \`${escapeMarkdown(shortcut.file ?? "")}\``);
		return value;
	}
	if (shortcut.type === "folder") {
		value.appendMarkdown(`folder: \`${escapeMarkdown(shortcut.folder ?? "")}\``);
		return value;
	}
	value.appendCodeblock(shortcut.command ?? "", "shellscript");
	if (shortcut.cwd) {
		value.appendMarkdown(`\n\ncwd: \`${escapeMarkdown(shortcut.cwd)}\``);
	}
	if (shortcut.terminalName) {
		value.appendMarkdown(`\n\nterminal: \`${escapeMarkdown(shortcut.terminalName)}\``);
	}
	return value;
}

function displayDirname(uri) {
	const fsPath = uri.fsPath || uri.path;
	const dir = path.dirname(fsPath);
	const home = process.env.HOME ?? process.env.USERPROFILE;
	if (home && (dir === home || dir.startsWith(`${home}/`) || dir.startsWith(`${home}\\`))) {
		return `~${dir.slice(home.length)}`;
	}
	return dir;
}

function resourceLabel(resource) {
	if (!resource) return "Shortcut";
	const uri = vscode.Uri.parse(resource);
	return path.basename(uri.fsPath || uri.path) || resource;
}

function resolveVariablesFallback(value) {
	const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
	return value
		.replaceAll("${workspaceFolder}", workspaceFolder?.uri.fsPath ?? "")
		.replaceAll("${workspaceFolderBasename}", workspaceFolder?.name ?? "")
		.replaceAll("${userHome}", process.env.HOME ?? process.env.USERPROFILE ?? "")
		.replace(/\$\{env:([^}]+)\}/gu, (_match, name) => process.env[name] ?? "");
}

function parseDraggedShortcutIds(value) {
	try {
		const parsed = JSON.parse(value);
		return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
	} catch {
		return [];
	}
}

function isFileNotFound(error) {
	return (
		error instanceof vscode.FileSystemError &&
		(error.code === "FileNotFound" || error.name === "EntryNotFound (FileSystemError)")
	);
}

function optional(value) {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function escapeMarkdown(value) {
	return value.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("*", "\\*");
}

function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}

module.exports = { activate, deactivate };
