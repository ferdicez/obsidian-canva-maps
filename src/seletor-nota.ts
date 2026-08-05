import { App, FuzzySuggestModal, TFile } from "obsidian";

/** Escolhe uma nota do vault para vincular a um bloco. */
export class SeletorNota extends FuzzySuggestModal<TFile> {
	constructor(app: App, private aoEscolher: (arquivo: TFile) => void) {
		super(app);
		this.setPlaceholder("Buscar nota para vincular ao bloco…");
	}

	getItems(): TFile[] {
		return this.app.vault.getMarkdownFiles();
	}

	getItemText(arquivo: TFile): string {
		return arquivo.path;
	}

	onChooseItem(arquivo: TFile): void {
		this.aoEscolher(arquivo);
	}
}
