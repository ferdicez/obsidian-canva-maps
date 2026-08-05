import { TextFileView, WorkspaceLeaf } from "obsidian";
import { Mapa, escreverMapa, lerMapa, mapaVazio } from "./tipos";
import { TelaMapa } from "./tela-mapa";

export const TIPO_VISTA_MAPA = "canva-maps-mapa";

/**
 * A aba que abre um arquivo .cmap.
 *
 * Herda de TextFileView porque o Obsidian já cuida de ler o arquivo, marcar como sujo e
 * gravar de volta — só precisamos dizer como o texto vira tela (`setViewData`) e como a
 * tela vira texto (`getViewData`).
 */
export class VistaMapa extends TextFileView {
	private mapa: Mapa = mapaVazio();
	private tela: TelaMapa | null = null;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
	}

	getViewType(): string {
		return TIPO_VISTA_MAPA;
	}

	getIcon(): string {
		return "layout-dashboard";
	}

	getDisplayText(): string {
		return this.file?.basename ?? "Mapa";
	}

	/** Texto que será gravado no arquivo. */
	getViewData(): string {
		return escreverMapa(this.mapa);
	}

	/**
	 * Recebe o conteúdo do arquivo. Chamado ao abrir e sempre que o arquivo muda no disco
	 * (sincronização, edição externa) — por isso reaproveita a tela em vez de recriá-la.
	 */
	setViewData(dados: string, limpar: boolean): void {
		this.mapa = lerMapa(dados);

		if (limpar || !this.tela) {
			this.montarTela();
		} else {
			this.tela.definirMapa(this.mapa);
		}
	}

	/**
	 * Chamado quando a aba é esvaziada (ex.: trocando de arquivo na mesma aba).
	 * `definirMapa` reancora a seleção e, como o mapa está vazio, fecha o painel —
	 * senão ele continuaria editando um bloco do arquivo anterior.
	 */
	clear(): void {
		this.mapa = mapaVazio();
		this.tela?.definirMapa(this.mapa);
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass("cmap-conteudo");
		this.contentEl.addEventListener("keydown", this.aoTeclar);
	}

	async onClose(): Promise<void> {
		this.contentEl.removeEventListener("keydown", this.aoTeclar);
		this.tela?.desligarEventos();
		this.tela?.destruir();
		this.tela = null;
	}

	private aoTeclar = (e: KeyboardEvent): void => {
		if (this.tela?.tratarTecla(e)) {
			e.preventDefault();
			e.stopPropagation();
		}
	};

	private montarTela(): void {
		this.tela?.desligarEventos();
		this.tela?.destruir();
		this.contentEl.empty();

		this.tela = new TelaMapa(this.contentEl, this.app, this.mapa, () => this.marcarSujo());
		this.tela.desenhar();

		// Sem foco no contentEl o keydown nunca chega até ele: a tecla dispara no elemento
		// focado (que seria o body) e sobe por ali, não desce. tabIndex -1 só torna focável;
		// é o focus() que faz os atalhos existirem de fato.
		this.contentEl.tabIndex = -1;
		this.contentEl.focus();
	}

	/** Avisa o Obsidian que há mudanças a gravar. Ele agenda a escrita do arquivo. */
	private marcarSujo(): void {
		this.requestSave();
	}
}
