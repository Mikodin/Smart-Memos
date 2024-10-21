import { type App, type TFile, TFolder, normalizePath, MarkdownView } from "obsidian";

export async function saveFile(
	app: App,
	audioBlob: Blob,
	fileName: string,
	path: string,
): Promise<TFile> {
	try {
		const normalizedPath = normalizePath(path);
		const filePath = `${normalizedPath}/${fileName}`;

		await ensureDirectoryExists(app, normalizedPath);

		const arrayBuffer = await audioBlob.arrayBuffer();
		const uint8Array = new Uint8Array(arrayBuffer);

		const file = await app.vault.createBinary(filePath, uint8Array);
		if (!file) {
			throw new Error("File creation failed and returned null");
		}
		return file;
	} catch (error) {
		console.error("Error saving audio file:", error);
		throw error;
	}
}

export async function readBinaryFile(app: App, path: string): Promise<ArrayBuffer> {
	const fileExists = await app.vault.adapter.exists(path);
	if (!fileExists) throw new Error(`${path} does not exist`);
	return app.vault.adapter.readBinary(path);
}

export async function createNewNote(app: App, path: string): Promise<MarkdownView> {
	const newFile = await app.vault.create(path, '');
	return await app.workspace.openLinkText(newFile.path, '', true);
}

export function insertLinkInEditor(editor: Editor, filePath: string) {
	const cursor = editor.getCursor();
	const link = `![[${filePath}]]`;
	editor.replaceRange(link, cursor);
	editor.replaceRange('', { line: cursor.line, ch: cursor.ch }, { line: cursor.line, ch: cursor.ch });
}

async function ensureDirectoryExists(app: App, folderPath: string) {
	const parts = folderPath.split("/");
	let currentPath = "";

	for (const part of parts) {
		currentPath = currentPath ? `${currentPath}/${part}` : part;

		try {
			const folder = app.vault.getAbstractFileByPath(currentPath);
			if (!folder) {
				await app.vault.createFolder(currentPath);
			} else if (folder instanceof TFolder) {
				console.log(`Folder already exists: ${currentPath}`);
			} else {
				throw new Error(`${currentPath} is not a folder`);
			}
		} catch (error) {
			if (error.message.includes("Folder already exists")) {
				// Folder already exists, continue to the next part
				console.log(`Handled existing folder: ${currentPath}`);
			} else {
				console.error(`Error ensuring directory exists: ${error.message}`);
				throw error;
			}
		}
	}
}
