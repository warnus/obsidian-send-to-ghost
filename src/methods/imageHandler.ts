import { App, TFile, normalizePath } from "obsidian";
import { signToken, uploadImage } from "./ghostApi";

const IMAGE_EXTENSIONS = /\.(png|jpg|jpeg|gif|webp|svg)$/i;

const MIME_TYPES: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	svg: "image/svg+xml",
};

export function getMimeType(ext: string): string {
	return MIME_TYPES[ext.toLowerCase()] || "application/octet-stream";
}

export function extractImageRefs(markdown: string): string[] {
	const refs = new Set<string>();

	// Obsidian wikilink embeds: ![[name.png]] or ![[name.png|alias]]
	const wikilinkRe = /!\[\[([^\]|]+\.(?:png|jpg|jpeg|gif|webp|svg))(?:[|][^\]]*)?\]\]/gi;
	let match;
	while ((match = wikilinkRe.exec(markdown)) !== null) {
		refs.add(match[1]);
	}

	// Standard markdown images: ![alt](path.png)
	const standardRe = /!\[[^\]]*\]\(([^)]+\.(?:png|jpg|jpeg|gif|webp|svg))\)/gi;
	while ((match = standardRe.exec(markdown)) !== null) {
		// Skip external URLs
		if (!match[1].startsWith("http://") && !match[1].startsWith("https://")) {
			refs.add(match[1]);
		}
	}

	return Array.from(refs);
}

export function replaceWikilinksWithStandardMd(markdown: string): string {
	// ![[name.png]] → ![name.png](name.png)
	// ![[name.png|alias]] → ![alias](name.png)
	return markdown.replace(
		/!\[\[([^\]|]+\.(?:png|jpg|jpeg|gif|webp|svg))(?:\|([^\]]*))?\]\]/gi,
		(_, path, alias) => {
			const label = alias || path;
			return `![${label}](${path})`;
		}
	);
}

export function resolveVaultImagePath(app: App, imageName: string, sourceFile: TFile): TFile | null {
	// Primary: Obsidian's wikilink resolution (handles all vault configurations)
	const resolved = app.metadataCache.getFirstLinkpathDest(imageName, sourceFile.path);
	if (resolved instanceof TFile) return resolved;

	// Fallback: treat as relative/absolute vault path
	const byPath = app.vault.getAbstractFileByPath(normalizePath(imageName));
	if (byPath instanceof TFile) return byPath;

	return null;
}

export async function uploadAllImages(
	app: App,
	baseUrl: string,
	key: string,
	markdown: string,
	sourceFile: TFile,
	debug: boolean
): Promise<{ imageMap: Map<string, string>; failCount: number }> {
	const imageMap = new Map<string, string>();
	const refs = extractImageRefs(markdown);
	let failCount = 0;

	for (const ref of refs) {
		const vaultFile = resolveVaultImagePath(app, ref, sourceFile);
		if (!vaultFile) {
			if (debug) console.log(`[Ghost] Image not found in vault: ${ref}`);
			failCount++;
			continue;
		}
		try {
			const buffer = await app.vault.readBinary(vaultFile);
			const mimeType = getMimeType(vaultFile.extension);
			const token = signToken(key);
			const ghostUrl = await uploadImage(baseUrl, token, vaultFile.name, buffer, mimeType);
			imageMap.set(ref, ghostUrl);
			if (debug) console.log(`[Ghost] Uploaded image: ${ref} → ${ghostUrl}`);
		} catch (err) {
			if (debug) console.error(`[Ghost] Failed to upload image: ${ref}`, err);
			failCount++;
		}
	}

	return { imageMap, failCount };
}

export function replaceImageRefsInMarkdown(markdown: string, imageMap: Map<string, string>): string {
	let result = markdown;
	for (const [ref, ghostUrl] of imageMap) {
		// Replace standard markdown image src: ![alt](ref) → ![alt](ghostUrl)
		const escapedRef = ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		result = result.replace(
			new RegExp(`(!\\[[^\\]]*\\])\\(${escapedRef}\\)`, "g"),
			`$1(${ghostUrl})`
		);
	}
	return result;
}

export async function writeFrontmatterField(
	app: App,
	file: TFile,
	key: string,
	value: string
): Promise<void> {
	await app.vault.process(file, (content: string) => {
		if (content.startsWith("---")) {
			const endIndex = content.indexOf("---", 3);
			if (endIndex !== -1) {
				const frontmatterBlock = content.slice(3, endIndex);
				if (new RegExp(`^${key}:`, "m").test(frontmatterBlock)) {
					return content.replace(
						new RegExp(`^(${key}:\\s*).*$`, "m"),
						`$1${value}`
					);
				}
				return content.slice(0, endIndex) + `${key}: ${value}\n` + content.slice(endIndex);
			}
		}
		return `---\n${key}: ${value}\n---\n${content}`;
	});
}
