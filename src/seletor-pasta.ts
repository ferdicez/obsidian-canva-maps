import { App, FuzzySuggestModal, TFolder } from "obsidian";

/** Escolhe uma pasta do vault. A raiz aparece como "/" na lista. */
export class SeletorPasta extends FuzzySuggestModal<TFolder> {
	constructor(app: App, private aoEscolher: (pasta: TFolder) => void) {
		super(app);
		this.setPlaceholder("Buscar pasta…");
	}

	getItems(): TFolder[] {
		const pastas: TFolder[] = [];
		// getAllLoadedFiles inclui a raiz; getFiles() traria só arquivos.
		for (const arquivo of this.app.vault.getAllLoadedFiles()) {
			if (arquivo instanceof TFolder) pastas.push(arquivo);
		}
		return pastas;
	}

	getItemText(pasta: TFolder): string {
		return pasta.isRoot() ? "/" : pasta.path;
	}

	onChooseItem(pasta: TFolder): void {
		this.aoEscolher(pasta);
	}
}
