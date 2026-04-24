/* eslint-disable @typescript-eslint/no-var-requires */
import { SettingsProp } from "./../types/index";
import { MarkdownView, Notice } from "obsidian";
import { signToken, getPost, createPost, updatePost, uploadImage } from "./ghostApi";
import {
	uploadAllImages,
	replaceWikilinksWithStandardMd,
	replaceImageRefsInMarkdown,
	resolveVaultImagePath,
	getMimeType,
	writeFrontmatterField,
} from "./imageHandler";

const matter = require("gray-matter");
const MarkdownIt = require("markdown-it");

const md = new MarkdownIt();

export const publishPost = async (view: MarkdownView, settings: SettingsProp) => {
	const key = settings.adminToken;
	if (!key.includes(":")) {
		new Notice("Error: Ghost API Key is invalid.");
		return;
	}

	const app = view.app;
	const noteFile = app.workspace.getActiveFile();
	if (!noteFile) {
		new Notice("No active file found.");
		return;
	}

	// @ts-ignore
	const metaMatter = app.metadataCache.getFileCache(noteFile)?.frontmatter;
	const rawMarkdown = view.getViewData();
	const data = matter(rawMarkdown);

	try {
		// --- IMAGE PIPELINE ---
		const { imageMap, failCount } = await uploadAllImages(
			app,
			settings.url,
			key,
			data.content,
			noteFile,
			settings.debug
		);

		let processedMd = replaceWikilinksWithStandardMd(data.content);
		processedMd = replaceImageRefsInMarkdown(processedMd, imageMap);
		const html = md.render(processedMd);

		// --- FEATURE IMAGE ---
		let featureImage: string | undefined = metaMatter?.feature_image || undefined;
		if (featureImage && !featureImage.startsWith("http://") && !featureImage.startsWith("https://")) {
			const featureFile = resolveVaultImagePath(app, featureImage, noteFile);
			if (featureFile) {
				try {
					const buffer = await app.vault.readBinary(featureFile);
					const mimeType = getMimeType(featureFile.extension);
					const token = signToken(key);
					featureImage = await uploadImage(settings.url, token, featureFile.name, buffer, mimeType);
				} catch (err) {
					if (settings.debug) console.error("[Ghost] Failed to upload feature image", err);
				}
			}
		}

		// --- BUILD POST BODY ---
		const postBody: any = {
			title: metaMatter?.title || view.file?.basename || noteFile.basename,
			tags: metaMatter?.tags || [],
			featured: metaMatter?.featured || false,
			status: metaMatter?.published ? "published" : "draft",
			excerpt: metaMatter?.excerpt || undefined,
			feature_image: featureImage,
			html,
		};

		// --- CREATE OR UPDATE ---
		const ghostId: string | undefined = metaMatter?.ghost_id;
		let result;
		let isNew = false;

		if (ghostId) {
			try {
				const getToken = signToken(key);
				const existing = await getPost(settings.url, getToken, ghostId);
				postBody.updated_at = existing.updated_at;

				if (settings.debug) console.log("[Ghost] Updating post:", ghostId);
				const putToken = signToken(key);
				result = await updatePost(settings.url, putToken, ghostId, { posts: [postBody] });
			} catch (err: any) {
				if (err.status === 404) {
					if (settings.debug) console.log("[Ghost] Post not found, creating new post");
					delete postBody.updated_at;
					const postToken = signToken(key);
					result = await createPost(settings.url, postToken, { posts: [postBody] });
					isNew = true;
				} else {
					throw err;
				}
			}
		} else {
			const postToken = signToken(key);
			result = await createPost(settings.url, postToken, { posts: [postBody] });
			isNew = true;
		}

		if (settings.debug) console.log("[Ghost] Result:", JSON.stringify(result));

		// --- WRITE BACK ghost_id ---
		if (isNew) {
			await writeFrontmatterField(app, noteFile, "ghost_id", result.id);
		}

		// --- NOTIFY ---
		new Notice(`"${result.title}" has been ${result.status} successfully!`);
		if (failCount > 0) {
			new Notice(`Warning: ${failCount} image(s) failed to upload.`);
		}

	} catch (error: any) {
		new Notice(
			`Couldn't connect to the Ghost API. Is the API URL and Admin API Key correct?\n\n${error.name}: ${error.message}`
		);
	}
};
