import { Notice, Plugin, TFolder, normalizePath } from "obsidian";
import { EXTENSAO_CMAP, escreverMapa, mapaVazio } from "./tipos";
import { TIPO_VISTA_MAPA, VistaMapa } from "./vista-mapa";

export default class CanvaMapsPlugin extends Plugin {
	async onload() {
		this.registerView(TIPO_VISTA_MAPA, (leaf) => new VistaMapa(leaf));

		// É isto que faz um arquivo .cmap abrir nesta view ao clicar nele na barra lateral.
		this.registerExtensions([EXTENSAO_CMAP], TIPO_VISTA_MAPA);

		this.addCommand({
			id: "novo-mapa",
			name: "Criar novo mapa",
			callback: () => this.criarMapa(),
		});

		// Item de menu na pasta, para criar o mapa já no lugar certo.
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, arquivo) => {
				if (!(arquivo instanceof TFolder)) return;
				menu.addItem((item) =>
					item
						.setTitle("Novo mapa")
						.setIcon("layout-dashboard")
						.onClick(() => this.criarMapa(arquivo))
				);
			})
		);
	}

	/** Cria um .cmap vazio e abre. Sem pasta, cai na pasta padrão de novas notas do vault. */
	private async criarMapa(pasta?: TFolder): Promise<void> {
		const destino = pasta ?? this.pastaPadrao();
		const caminho = await this.caminhoLivre(destino, "Novo mapa");

		try {
			const arquivo = await this.app.vault.create(caminho, escreverMapa(mapaVazio()));
			await this.app.workspace.getLeaf(true).openFile(arquivo);
		} catch (erro) {
			new Notice(`Não foi possível criar o mapa: ${erro instanceof Error ? erro.message : erro}`);
		}
	}

	private pastaPadrao(): TFolder {
		const arquivoAtivo = this.app.workspace.getActiveFile();
		if (arquivoAtivo?.parent) return arquivoAtivo.parent;
		return this.app.vault.getRoot();
	}

	/** Acha um nome livre: "Novo mapa.cmap", "Novo mapa 2.cmap", … */
	private async caminhoLivre(pasta: TFolder, base: string): Promise<string> {
		const prefixo = pasta.isRoot() ? "" : `${pasta.path}/`;

		for (let n = 1; n < 1000; n++) {
			const nome = n === 1 ? base : `${base} ${n}`;
			const caminho = normalizePath(`${prefixo}${nome}.${EXTENSAO_CMAP}`);
			if (!this.app.vault.getAbstractFileByPath(caminho)) return caminho;
		}

		// Fallback improvável, mas melhor que estourar: usa o timestamp.
		return normalizePath(`${prefixo}${base} ${Date.now()}.${EXTENSAO_CMAP}`);
	}
}
