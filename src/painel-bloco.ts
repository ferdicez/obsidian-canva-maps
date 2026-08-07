import { setIcon } from "obsidian";
import { Bloco, CORES, ROTULO_DA_COR, novoId } from "./tipos";

/**
 * Painel lateral de edição do bloco selecionado. Fica ancorado à direita da tela do mapa
 * e edita o bloco no lugar — cada alteração chama `aoMudar`, que persiste e redesenha o card.
 *
 * O painel é reconstruído do zero a cada troca de bloco, mas NÃO a cada tecla digitada:
 * redesenhar enquanto se digita perderia o cursor. Por isso os campos de texto avisam a
 * mudança sem pedir redesenho (`redesenhar: false`).
 *
 * O vínculo com uma nota do vault saiu daqui a pedido dela (era fácil de acionar sem querer
 * e o rótulo não dizia o que fazia). O campo continua no formato `.cmap` e no menu de
 * contexto do bloco, então mapas que já tinham nota vinculada não perdem nada.
 */
export class PainelBloco {
	private raiz: HTMLElement;
	private bloco: Bloco | null = null;

	constructor(
		pai: HTMLElement,
		private aoMudar: (redesenhar: boolean) => void,
		private aoEntrar: (bloco: Bloco) => void,
		private aoExcluir: (bloco: Bloco) => void,
		/** Guarda o estado atual no histórico antes de a edição acontecer. */
		private antesDeMudar: (rotulo: string) => void
	) {
		this.raiz = pai.createDiv({ cls: "cmap-painel" });
		this.raiz.addClass("cmap-painel-oculto");
	}

	/** Mostra o painel para um bloco, ou o esconde quando `bloco` é null. */
	mostrar(bloco: Bloco | null): void {
		this.bloco = bloco;
		this.raiz.empty();
		this.raiz.toggleClass("cmap-painel-oculto", bloco === null);
		if (!bloco) return;

		this.montarCabecalho(bloco);
		this.montarTitulo(bloco);
		this.montarTexto(bloco);
		this.montarCor(bloco);
		this.montarChecklist(bloco);
		this.montarAcoes(bloco);
	}

	/**
	 * Aponta o painel para `bloco` sem reconstruí-lo à toa: se já é exatamente o mesmo objeto,
	 * não faz nada. Reconstruir esvazia os campos, e o mapa recarrega a cada mudança externa do
	 * arquivo — sem esta guarda, um sync no meio da digitação apagaria o que está sendo escrito.
	 */
	reapontar(bloco: Bloco | null): void {
		if (this.bloco === bloco) return;
		this.mostrar(bloco);
	}

	/** Redesenha o painel se ele estiver mostrando este bloco (ex.: item de checklist marcado no card). */
	atualizarSe(bloco: Bloco): void {
		if (this.bloco?.id === bloco.id) this.mostrar(bloco);
	}

	/** Fecha o painel se estiver mostrando este bloco (ex.: o bloco foi excluído). */
	fecharSe(idBloco: string): void {
		if (this.bloco?.id === idBloco) this.mostrar(null);
	}

	private montarCabecalho(bloco: Bloco): void {
		const cabecalho = this.raiz.createDiv({ cls: "cmap-painel-cabecalho" });
		cabecalho.createSpan({ cls: "cmap-painel-titulo", text: "Bloco" });

		const fechar = cabecalho.createEl("button", { cls: "cmap-painel-fechar", attr: { "aria-label": "Fechar painel" } });
		setIcon(fechar, "x");
		fechar.addEventListener("click", () => {
			this.mostrar(null);
			this.aoMudar(true);
		});

		void bloco;
	}

	private montarTitulo(bloco: Bloco): void {
		const campo = this.criarSecao("Título").createEl("input", {
			cls: "cmap-painel-input",
			attr: { type: "text", placeholder: "Nome do bloco" },
		});
		campo.value = bloco.titulo;
		campo.addEventListener("input", () => {
			// Rótulo estável: teclas seguidas no mesmo campo viram um passo só de desfazer,
			// em vez de voltar letra por letra.
			this.antesDeMudar(`titulo:${bloco.id}`);
			bloco.titulo = campo.value;
			this.aoMudar(false);
		});
	}

	private montarTexto(bloco: Bloco): void {
		const campo = this.criarSecao("Observações").createEl("textarea", {
			cls: "cmap-painel-textarea",
			attr: { placeholder: "Anotações sobre este bloco…", rows: "6" },
		});
		campo.value = bloco.texto;
		campo.addEventListener("input", () => {
			this.antesDeMudar(`texto:${bloco.id}`);
			bloco.texto = campo.value;
			this.aoMudar(false);
		});
	}

	private montarCor(bloco: Bloco): void {
		const grade = this.criarSecao("Cor").createDiv({ cls: "cmap-painel-cores" });

		for (const cor of CORES) {
			const botao = grade.createEl("button", {
				cls: `cmap-painel-cor cmap-cor-${cor}`,
				attr: { "aria-label": ROTULO_DA_COR[cor] },
			});
			botao.toggleClass("cmap-painel-cor-ativa", bloco.cor === cor);
			botao.addEventListener("click", () => {
				this.antesDeMudar(`cor:${bloco.id}:${cor}`);
				bloco.cor = cor;
				this.aoMudar(true);
				this.mostrar(bloco);
			});
		}
	}

	private montarChecklist(bloco: Bloco): void {
		const secao = this.criarSecao("Checklist");
		const lista = secao.createDiv({ cls: "cmap-painel-checklist" });

		for (const item of bloco.checklist) {
			const linha = lista.createDiv({ cls: "cmap-painel-check-linha" });

			const marca = linha.createEl("input", { attr: { type: "checkbox" } });
			marca.checked = item.feito;
			marca.addEventListener("change", () => {
				this.antesDeMudar(`check:${item.id}`);
				item.feito = marca.checked;
				this.aoMudar(true);
			});

			const texto = linha.createEl("input", { cls: "cmap-painel-check-texto", attr: { type: "text" } });
			texto.value = item.texto;
			texto.addEventListener("input", () => {
				this.antesDeMudar(`check-texto:${item.id}`);
				item.texto = texto.value;
				this.aoMudar(false);
			});

			const remover = linha.createEl("button", {
				cls: "cmap-painel-icone",
				attr: { "aria-label": "Remover item" },
			});
			setIcon(remover, "trash-2");
			remover.addEventListener("click", () => {
				this.antesDeMudar(`remover-item:${item.id}`);
				bloco.checklist.remove(item);
				this.aoMudar(true);
				this.mostrar(bloco);
			});
		}

		const adicionar = secao.createEl("button", { cls: "cmap-painel-botao", text: "+ Adicionar item" });
		adicionar.addEventListener("click", () => {
			this.antesDeMudar(`add-item:${bloco.id}:${Date.now()}`);
			bloco.checklist.push({ id: novoId(), texto: "", feito: false });
			this.aoMudar(true);
			this.mostrar(bloco);
			// Foca o item recém-criado para já sair digitando.
			const campos = this.raiz.querySelectorAll<HTMLInputElement>(".cmap-painel-check-texto");
			campos[campos.length - 1]?.focus();
		});
	}

	private montarAcoes(bloco: Bloco): void {
		const acoes = this.raiz.createDiv({ cls: "cmap-painel-acoes" });

		const entrar = acoes.createEl("button", { cls: "cmap-painel-botao mod-cta", text: "Entrar no bloco" });
		entrar.addEventListener("click", () => this.aoEntrar(bloco));

		const excluir = acoes.createEl("button", { cls: "cmap-painel-botao cmap-painel-perigo", text: "Excluir" });
		excluir.addEventListener("click", () => this.aoExcluir(bloco));
	}

	private criarSecao(rotulo: string): HTMLElement {
		const secao = this.raiz.createDiv({ cls: "cmap-painel-secao" });
		secao.createDiv({ cls: "cmap-painel-rotulo", text: rotulo });
		return secao;
	}

}
