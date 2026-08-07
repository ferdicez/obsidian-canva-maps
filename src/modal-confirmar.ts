import { App, Modal, Setting } from "obsidian";

/**
 * Confirmação para ações destrutivas: apagar um bloco leva junto tudo que estava dentro
 * dele, em qualquer profundidade — e o que some não está visível na tela para ela conferir
 * antes. Existe mesmo com Ctrl+Z, porque o problema é não perceber, não a irreversibilidade.
 */
export class ModalConfirmar extends Modal {
	constructor(
		app: App,
		private titulo: string,
		private mensagem: string,
		private aoConfirmar: () => void
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(this.titulo);
		this.contentEl.createEl("p", { text: this.mensagem });

		new Setting(this.contentEl)
			.addButton((botao) =>
				botao.setButtonText("Cancelar").onClick(() => this.close())
			)
			.addButton((botao) =>
				botao
					.setButtonText("Excluir")
					.setWarning()
					.onClick(() => {
						this.close();
						this.aoConfirmar();
					})
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
