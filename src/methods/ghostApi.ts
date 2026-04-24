import { requestUrl } from "obsidian";
import { sign } from "jsonwebtoken";
import * as https from "https";
import * as http from "http";
import { GhostPost } from "../types/index";

const VERSION = "v4";

export function signToken(key: string): string {
	const [id, secret] = key.split(":");
	return sign({}, Buffer.from(secret, "hex"), {
		keyid: id,
		algorithm: "HS256",
		expiresIn: "5m",
		audience: `/${VERSION}/admin/`,
	});
}

export async function getPost(baseUrl: string, token: string, postId: string): Promise<GhostPost> {
	const result = await requestUrl({
		url: `${baseUrl}/ghost/api/${VERSION}/admin/posts/${postId}/`,
		method: "GET",
		headers: {
			Authorization: `Ghost ${token}`,
		},
	});
	const json = result.json;
	if (result.status === 404 || json?.errors) {
		const err: any = new Error("Post not found");
		err.status = 404;
		throw err;
	}
	return json.posts[0] as GhostPost;
}

export async function createPost(baseUrl: string, token: string, body: object): Promise<GhostPost> {
	const result = await requestUrl({
		url: `${baseUrl}/ghost/api/${VERSION}/admin/posts/?source=html`,
		method: "POST",
		contentType: "application/json",
		headers: {
			Authorization: `Ghost ${token}`,
		},
		body: JSON.stringify(body),
	});
	const json = result.json;
	if (json?.errors) {
		throw new Error(json.errors[0]?.context || json.errors[0]?.message || "Create post failed");
	}
	return json.posts[0] as GhostPost;
}

export async function updatePost(baseUrl: string, token: string, postId: string, body: object): Promise<GhostPost> {
	const result = await requestUrl({
		url: `${baseUrl}/ghost/api/${VERSION}/admin/posts/${postId}/?source=html`,
		method: "PUT",
		contentType: "application/json",
		headers: {
			Authorization: `Ghost ${token}`,
		},
		body: JSON.stringify(body),
	});
	const json = result.json;
	if (result.status === 404 || (json?.errors && json.errors[0]?.errorType === "NotFoundError")) {
		const err: any = new Error("Post not found");
		err.status = 404;
		throw err;
	}
	if (json?.errors) {
		throw new Error(json.errors[0]?.context || json.errors[0]?.message || "Update post failed");
	}
	return json.posts[0] as GhostPost;
}

function buildMultipartBody(
	fileName: string,
	fileBuffer: ArrayBuffer,
	mimeType: string
): { body: ArrayBuffer; boundary: string } {
	const boundary = `----ObsidianGhostBoundary${Date.now()}`;
	const encoder = new TextEncoder();

	const header = encoder.encode(
		`--${boundary}\r\n` +
		`Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
		`Content-Type: ${mimeType}\r\n\r\n`
	);
	const fileBytes = new Uint8Array(fileBuffer);
	const middle = encoder.encode(
		`\r\n--${boundary}\r\n` +
		`Content-Disposition: form-data; name="ref"\r\n\r\n` +
		fileName +
		`\r\n--${boundary}--\r\n`
	);

	const total = new Uint8Array(header.length + fileBytes.length + middle.length);
	total.set(header, 0);
	total.set(fileBytes, header.length);
	total.set(middle, header.length + fileBytes.length);

	return { body: total.buffer, boundary };
}

export function uploadImage(
	baseUrl: string,
	token: string,
	fileName: string,
	fileBuffer: ArrayBuffer,
	mimeType: string
): Promise<string> {
	const { body, boundary } = buildMultipartBody(fileName, fileBuffer, mimeType);
	const buffer = Buffer.from(body);
	const urlObj = new URL(`${baseUrl}/ghost/api/${VERSION}/admin/images/upload`);
	const lib = urlObj.protocol === "https:" ? https : http;

	return new Promise((resolve, reject) => {
		const req = lib.request(
			{
				hostname: urlObj.hostname,
				port: urlObj.port || (urlObj.protocol === "https:" ? 443 : 80),
				path: urlObj.pathname + urlObj.search,
				method: "POST",
				headers: {
					Authorization: `Ghost ${token}`,
					"Content-Type": `multipart/form-data; boundary=${boundary}`,
					"Content-Length": buffer.length,
				},
			},
			(res) => {
				let data = "";
				res.on("data", (chunk) => (data += chunk));
				res.on("end", () => {
					try {
						const json = JSON.parse(data);
						if ((res.statusCode ?? 500) >= 400 || json?.errors) {
							reject(new Error(`Image upload failed: ${res.statusCode} ${json?.errors?.[0]?.message || ""}`));
						} else {
							resolve(json.images[0].url);
						}
					} catch (e) {
						reject(e);
					}
				});
			}
		);
		req.on("error", reject);
		req.write(buffer);
		req.end();
	});
}
