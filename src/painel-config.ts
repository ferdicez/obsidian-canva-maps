import { App, PluginSettingTab, Setting, TFolder } from "obsidian";
import type CanvaMapsPlugin from "./main";
import { SeletorPasta } from "./seletor-pasta";

/**
 * Painel de configurações. Um assunto só (onde salvar os mapas), então é lista simples —
 * a barra de abas da especificação só entra quando houver dois assuntos.
 * Ver `plugins/_docs/painel-de-configuracoes.md`.
 */
export class PainelConfigCanvaMaps extends PluginSettingTab {
	constructor(app: App, private plugin: CanvaMapsPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		// O scroll é devolvido no fim: redesenhar o painel inteiro o jogaria para o topo
		// a cada mudança, e ela perderia o lugar onde estava mexendo.
		const scrollAnterior = containerEl.scrollTop;

		containerEl.empty();
		containerEl.addClass("canva-maps-config");

		this.montarPastaDosMapas();

		containerEl.scrollTop = scrollAnterior;
	}

	private montarPastaDosMapas(): void {
		const config = this.plugin.configuracoes;

		const ajuste = new Setting(this.containerEl)
			.setName("Pasta dos mapas")
			.setDesc("Onde os mapas novos são criados. Sem uma pasta escolhida, o mapa nasce junto da nota aberta no momento.");

		ajuste.addButton((botao) =>
			botao
				.setButtonText(config.pastaDosMapas || "Escolher pasta…")
				.onClick(() => {
					new SeletorPasta(this.app, async (pasta: TFolder) => {
						this.plugin.configuracoes.pastaDosMapas = pasta.isRoot() ? "/" : pasta.path;
						await this.plugin.salvarConfiguracoes();
						this.display();
					}).open();
				})
		);

		// O botão de limpar só existe quando há o que limpar — senão vira ruído permanente.
		if (config.pastaDosMapas) {
			ajuste.addExtraButton((botao) =>
				botao
					.setIcon("x")
					.setTooltip("Usar a pasta da nota aberta")
					.onClick(async () => {
						this.plugin.configuracoes.pastaDosMapas = "";
						await this.plugin.salvarConfiguracoes();
						this.display();
					})
			);
		}

		if (!config.pastaDosMapas) {
			this.containerEl.createDiv({
				cls: "canva-maps-config-vazio",
				text: "Nenhuma pasta escolhida ainda.",
			});
		}
	}
}
