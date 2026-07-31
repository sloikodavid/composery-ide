import { ChevronDownIcon } from "lucide-react";
import { usageStepsPhrase } from "@/convex/model/box/usage";

const FAQ: { question: string; answer: string }[] = [
	{
		question: "Is the paid version different from what I can self-host?",
		answer:
			"The editor is the same open-source product that you'd run yourself, but Composery Cloud just does all the complicated Dev-ops stuff to host it, so you don't have to worry about buying a domain, setting up DNS, securing your server, and so on."
	},
	{
		question: "Do I need an app to use it on my phone?",
		answer:
			"Composery runs in your phone's browser and the UI is patched in all the right places for touch - open your box URL and you're in. Add it to your home screen as an app to get the seamless experience."
	},
	{
		question: "What if I break something?",
		answer:
			"You're free to experiment. Every box is snapshotted automatically and you can roll back to one in a click, or reset the box to a clean slate whenever you want. Box Pro also lets you take snapshots yourself, right before a big change, and choose how many of its snapshots are yours to take versus taken for you."
	},
	{
		// The figure is deliberately not repeated here. Each card above prints its
		// own plan's allowance from the plan table, and a number typed into this
		// answer as well is the copy that keeps advertising the old one.
		question: "Are there limits on disk or network traffic?",
		answer: `Yes, and both are meters on your box's page so you can watch them. The disk is the one on the plan you bought, and it counts everything on the machine - your files, the packages you installed, and the Docker images and build cache inside the box. Outbound traffic has a monthly allowance, shown on each card above, that counts from the start of your billing month. What arrives at your box is not counted at all, so pulling packages and images is free; serving a site or sending backups out is what moves it. You get an email at ${usageStepsPhrase()} of either, so you hear about it while you can still do something. Going a little over does not cut the box off; sustained excess is something Composery Cloud gets in touch about.`
	},
	{
		question: "How much control do I get over the OS?",
		answer:
			"Pretty much full control. You get passwordless sudo and systemd, so you can apt install packages, edit any file, and set up scheduled automations. Docker is installed, so devcontainers and docker compose work too. It runs as a container, so custom kernel stuff is probably the one thing you can't do."
	},
	{
		question: "Can I run a dev server and open it in the browser?",
		answer:
			"Yes. Anything you run on a port shows up in the Ports panel and opens at your box URL under /proxy/3000/ - signed in as you, not open to the world. You can also reach any port privately over SSH with a tunnel: ssh -L 5432:localhost:5432 your-box. Ports are not open to the internet: the box accepts HTTPS on its own domain and SSH, and nothing else."
	},
	{
		question: "What does it take to self-host?",
		answer:
			"Not much - a machine that runs Docker and a volume to keep your data on. The repo ships ready-made setups for Fly, Render, Railway, Kubernetes, and any VPS, with even more platforms documented."
	}
];

export function Faq() {
	return (
		<section className="space-y-4">
			<h2 className="font-heading text-2xl font-medium tracking-tight text-foreground">
				Common questions
			</h2>
			{FAQ.map(({ question, answer }) => (
				<details className="disclosure group" key={question}>
					<summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-2 text-sm font-medium text-foreground select-none [&::-webkit-details-marker]:hidden">
						{question}
						<ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 group-open:rotate-180" />
					</summary>
					<p className="pb-3 text-sm leading-7 text-muted-foreground">
						{answer}
					</p>
				</details>
			))}
		</section>
	);
}
