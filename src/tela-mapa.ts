import { App, Menu, Notice, TFile, setIcon } from "obsidian";
import {
	ALTURA_MINIMA,
	ALTURA_PADRAO,
	Bloco,
	LARGURA_MINIMA,
	LARGURA_PADRAO,
	Mapa,
	Nivel,
	ROTULO_DA_COR,
	Seta,
	blocosDoCaminho,
	contarDescendentes,
	nivelDoCaminho,
	novoBloco,
	novoId,
	progressoChecklist,
} from "./tipos";
import { Lado, desenharSetas, pontoNoLado } from "./setas";
import { Guia, encaixarAoMover, encaixarAoRedimensionar } from "./alinhamento";
import { alvoDeAninhamento, contem, posicaoLivreDentro } from "./aninhar";
import { Historico } from "./historico";
import { PainelBloco } from "./painel-bloco";
import { ModalConfirmar } from "./modal-confirmar";
import { SeletorNota } from "./seletor-nota";

const NS_SVG = "http://www.w3.org/2000/svg";

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 2.5;
const PASSO_ZOOM = 0.0015;

/** Distância em pixels que o ponteiro precisa andar para virar arrasto e não clique. */
const LIMIAR_ARRASTO = 4;

interface Camera {
	x: number;
	y: number;
	zoom: number;
}

/** O que está sendo arrastado no momento. */
type Arrasto =
	| { tipo: "nenhum" }
	| { tipo: "plano"; inicioX: number; inicioY: number; cameraX: number; cameraY: number }
	| {
			tipo: "bloco";
			/** O bloco sob o ponteiro — é ele que encaixa nas guias e define o alvo de aninhamento. */
			bloco: Bloco;
			inicioX: number;
			inicioY: number;
			blocoX: number;
			blocoY: number;
			/** Os demais selecionados, que acompanham o movimento mantendo a distância relativa. */
			acompanhantes: { bloco: Bloco; deslocX: number; deslocY: number }[];
			moveu: boolean;
	  }
	| {
			tipo: "laco";
			/** Canto onde o arrasto começou, em coordenadas do mapa. */
			inicioX: number;
			inicioY: number;
			atualX: number;
			atualY: number;
			/** Seleção que já existia, preservada quando o laço soma (Shift). */
			anteriores: Set<string>;
	  }
	| {
			tipo: "redimensionar";
			bloco: Bloco;
			inicioX: number;
			inicioY: number;
			largura: number;
			altura: number;
			/** Se o passo de desfazer já foi criado (no primeiro movimento real). */
			registrou: boolean;
	  }
	| { tipo: "seta"; de: Bloco; lado: Lado; x: number; y: number }
	| {
			tipo: "escalar-grupo";
			inicioX: number;
			inicioY: number;
			/** Se o passo de desfazer já foi criado (no primeiro movimento real). */
			registrou: boolean;
			/** Caixa que envolvia a seleção quando o gesto começou. */
			caixa: { x: number; y: number; largura: number; altura: number };
			/** Estado inicial de cada bloco, para a escala partir sempre do original. */
			originais: { bloco: Bloco; x: number; y: number; largura: number; altura: number }[];
	  };

/**
 * A tela do mapa: desenha um nível (os blocos de um bloco pai, ou a raiz) e trata
 * pan, zoom, arrasto, redimensionamento, setas e o menu de contexto.
 *
 * A tela é sempre de UM nível por vez. Entrar num bloco troca o caminho e redesenha —
 * é isso que dá a sensação de "o card virou uma página".
 */
export class TelaMapa {
	private raiz: HTMLElement;
	private area: HTMLElement;
	private plano: HTMLElement;
	private svg: SVGSVGElement;
	private trilhaEl: HTMLElement;
	private painel: PainelBloco;

	private camera: Camera = { x: 0, y: 0, zoom: 1 };
	private arrasto: Arrasto = { tipo: "nenhum" };
	private linhaProvisoria: SVGPathElement | null = null;
	/** Linhas-guia do encaixe, vivas só durante o arrasto. */
	private guias: SVGLineElement[] = [];
	/** Retângulo do laço de seleção, vivo só enquanto ela arrasta no fundo. */
	private lacoEl: HTMLElement | null = null;
	/** Moldura em volta da seleção múltipla, com a alça que escala o conjunto. */
	private caixaGrupoEl: HTMLElement | null = null;

	/** Caminho de ids até o nível aberto. Vazio = raiz. */
	private caminho: string[] = [];
	/**
	 * Blocos selecionados. O painel lateral só aparece quando há exatamente um — editar
	 * título e texto de vários ao mesmo tempo não faria sentido —, mas mover, excluir e
	 * colorir valem para o conjunto.
	 */
	private selecionados = new Set<string>();
	private setaSelecionada: string | null = null;
	private historico = new Historico();

	constructor(
		pai: HTMLElement,
		private app: App,
		private mapa: Mapa,
		private aoSalvar: () => void,
		/** Nome do arquivo, mostrado como raiz da trilha. */
		private nomeDoMapa: string = "",
		/** Volta para a galeria. Sem isso, o degrau "Mapas" não aparece na trilha. */
		private aoVoltarParaGaleria?: () => void
	) {
		this.raiz = pai.createDiv({ cls: "cmap-raiz" });

		this.trilhaEl = this.raiz.createDiv({ cls: "cmap-trilha" });

		const corpo = this.raiz.createDiv({ cls: "cmap-corpo" });
		this.area = corpo.createDiv({ cls: "cmap-area" });
		this.plano = this.area.createDiv({ cls: "cmap-plano" });

		this.svg = document.createElementNS(NS_SVG, "svg");
		this.svg.classList.add("cmap-svg");
		this.plano.appendChild(this.svg);

		this.painel = new PainelBloco(
			corpo,
			(redesenhar) => {
				this.aoSalvar();
				if (redesenhar) this.desenhar();
			},
			(bloco) => this.entrarNoBloco(bloco.id),
			(bloco) => this.pedirExclusao(bloco),
			(rotulo) => this.registrarNoHistorico(rotulo)
		);

		this.ligarEventos();
	}

	/**
	 * Troca o mapa exibido (arquivo alterado por fora, ou aba reaproveitada para outro arquivo)
	 * preservando o nível aberto quando possível.
	 *
	 * `lerMapa` devolve uma árvore de objetos NOVOS. Tudo que guardava referência para um bloco
	 * da árvore antiga — o painel lateral, o arrasto em curso — passaria a editar um objeto órfão,
	 * que não é mais serializado ao salvar: as edições sumiriam sem aviso. Por isso a seleção é
	 * reancorada por id, e o arrasto é abortado.
	 */
	/** Esquece o histórico de desfazer — usado quando a aba passa a mostrar outro arquivo. */
	esquecerHistorico(): void {
		this.historico.limpar();
	}

	definirMapa(mapa: Mapa): void {
		this.mapa = mapa;
		this.arrasto = { tipo: "nenhum" };
		this.linhaProvisoria?.remove();
		this.linhaProvisoria = null;
		this.lacoEl?.remove();
		this.lacoEl = null;
		this.caixaGrupoEl?.remove();
		this.caixaGrupoEl = null;

		if (!nivelDoCaminho(this.mapa, this.caminho)) this.caminho = [];

		this.reancorarSelecao();
		this.desenhar();
	}

	/** Reaponta a seleção para os objetos equivalentes da árvore atual, ou limpa o que sumiu. */
	private reancorarSelecao(): void {
		const nivel = this.nivelAtual();

		// Descarta da seleção o que não existe mais no nível (bloco apagado por fora).
		const existentes = new Set(nivel.blocos.map((b) => b.id));
		for (const id of [...this.selecionados]) {
			if (!existentes.has(id)) this.selecionados.delete(id);
		}

		this.painel.reapontar(this.blocoUnicoSelecionado());

		if (this.setaSelecionada && !nivel.setas.some((s) => s.id === this.setaSelecionada)) {
			this.setaSelecionada = null;
		}
	}

	destruir(): void {
		this.raiz.remove();
	}

	// -------------------------------------------------------------------------
	// Desfazer / refazer
	// -------------------------------------------------------------------------

	/**
	 * Guarda o estado atual como ponto de retorno. Chamar SEMPRE antes de mexer no mapa.
	 *
	 * O `rotulo` agrupa ações repetidas num passo só: use um valor estável enquanto a ação
	 * continua (ex.: `texto:<id>` durante a digitação) e um valor único quando cada
	 * ocorrência deve ser um passo próprio.
	 */
	private registrarNoHistorico(rotulo: string): void {
		this.historico.registrar(this.mapa, rotulo, Date.now());
	}

	private desfazer(): void {
		const anterior = this.historico.desfazer(this.mapa, Date.now());
		if (!anterior) {
			new Notice("Nada para desfazer.");
			return;
		}
		this.aplicarEstado(anterior);
	}

	private refazer(): void {
		const proximo = this.historico.refazer(this.mapa, Date.now());
		if (!proximo) {
			new Notice("Nada para refazer.");
			return;
		}
		this.aplicarEstado(proximo);
	}

	/**
	 * Troca o mapa pelo estado vindo do histórico.
	 *
	 * O conteúdo do mapa é substituído NO LUGAR (mesmo objeto) porque `this.mapa` é a mesma
	 * referência que a view serializa ao salvar — trocar o objeto aqui faria o arquivo
	 * continuar sendo gravado a partir do mapa antigo.
	 */
	private aplicarEstado(novo: Mapa): void {
		this.mapa.blocos = novo.blocos;
		this.mapa.setas = novo.setas;
		this.mapa.versao = novo.versao;

		// O nível aberto pode não existir mais no estado restaurado (desfazer a criação do
		// bloco em que se entrou), e a seleção aponta para objetos que já não estão na árvore.
		if (!nivelDoCaminho(this.mapa, this.caminho)) this.caminho = [];
		this.limparSelecao();

		this.aoSalvar();
		this.desenhar();
	}

	// -------------------------------------------------------------------------
	// Navegação entre níveis
	// -------------------------------------------------------------------------

	/**
	 * O nível aberto. Atenção: o objeto devolvido é um invólucro descartável — os ARRAYS
	 * dentro dele são os do modelo, mas trocar `nivel.setas = ...` só reatribui a cópia e
	 * a mudança se perde. Para remover setas use `removerSetas`, que muta no lugar.
	 */
	private nivelAtual(): Nivel {
		// Se o caminho quebrou (bloco apagado por fora), volta para a raiz em vez de estourar.
		return nivelDoCaminho(this.mapa, this.caminho) ?? { blocos: this.mapa.blocos, setas: this.mapa.setas };
	}

	/** Remove do modelo as setas que casarem com o critério, mutando o array no lugar. */
	private removerSetas(criterio: (seta: Seta) => boolean): void {
		const setas = this.nivelAtual().setas;
		for (let i = setas.length - 1; i >= 0; i--) {
			if (criterio(setas[i])) setas.splice(i, 1);
		}
	}

	private entrarNoBloco(id: string): void {
		this.caminho.push(id);
		this.limparSelecao();
		// Cada nível começa com a câmera no lugar de origem — senão você "entra" num vazio.
		this.camera = { x: 0, y: 0, zoom: 1 };
		this.desenhar();
	}

	/** Volta um nível. Sem efeito na raiz. */
	voltar(): void {
		if (this.caminho.length === 0) return;
		this.caminho.pop();
		this.limparSelecao();
		this.camera = { x: 0, y: 0, zoom: 1 };
		this.desenhar();
	}

	/** Vai direto para um nível da trilha (índice = quantos blocos manter no caminho). */
	private irParaNivel(profundidade: number): void {
		this.caminho = this.caminho.slice(0, profundidade);
		this.limparSelecao();
		this.camera = { x: 0, y: 0, zoom: 1 };
		this.desenhar();
	}

	private limparSelecao(): void {
		this.selecionados.clear();
		this.setaSelecionada = null;
		this.painel.mostrar(null);
	}

	/** O bloco selecionado quando há exatamente um; null com zero ou vários. */
	private blocoUnicoSelecionado(): Bloco | null {
		if (this.selecionados.size !== 1) return null;
		const id = [...this.selecionados][0];
		return this.nivelAtual().blocos.find((b) => b.id === id) ?? null;
	}

	/** Os blocos selecionados que existem no nível atual, na ordem em que estão no mapa. */
	private blocosSelecionados(): Bloco[] {
		return this.nivelAtual().blocos.filter((b) => this.selecionados.has(b.id));
	}

	// -------------------------------------------------------------------------
	// Desenho
	// -------------------------------------------------------------------------

	desenhar(): void {
		this.desenharTrilha();
		this.desenharPlano();
	}

	private desenharTrilha(): void {
		this.trilhaEl.empty();

		const voltar = this.trilhaEl.createEl("button", {
			cls: "cmap-trilha-voltar",
			attr: { "aria-label": "Voltar um nível" },
		});
		setIcon(voltar, "arrow-left");
		voltar.disabled = this.caminho.length === 0;
		voltar.addEventListener("click", () => this.voltar());

		const caminho = this.trilhaEl.createDiv({ cls: "cmap-trilha-itens" });

		// Primeiro degrau da trilha: a galeria. Sem isto não haveria como voltar para a
		// visão do conjunto sem passar pela barra lateral.
		if (this.aoVoltarParaGaleria) {
			const galeria = caminho.createEl("button", { cls: "cmap-trilha-item", text: "Mapas" });
			galeria.addEventListener("click", () => this.aoVoltarParaGaleria?.());
			caminho.createSpan({ cls: "cmap-trilha-sep", text: "›" });
		}

		const raiz = caminho.createEl("button", {
			cls: "cmap-trilha-item",
			text: this.nomeDoMapa || "Mapa",
		});
		if (this.caminho.length === 0) raiz.addClass("cmap-trilha-atual");
		else raiz.addEventListener("click", () => this.irParaNivel(0));

		const blocos = blocosDoCaminho(this.mapa, this.caminho);
		blocos.forEach((bloco, i) => {
			caminho.createSpan({ cls: "cmap-trilha-sep", text: "›" });
			const item = caminho.createEl("button", {
				cls: "cmap-trilha-item",
				text: bloco.titulo || "Sem título",
			});
			// O último item é o nível atual: fica destacado e não navega.
			if (i === blocos.length - 1) item.addClass("cmap-trilha-atual");
			else item.addEventListener("click", () => this.irParaNivel(i + 1));
		});

		const acoes = this.trilhaEl.createDiv({ cls: "cmap-trilha-acoes" });
		const adicionar = acoes.createEl("button", { cls: "cmap-trilha-botao", text: "+ Bloco" });
		adicionar.addEventListener("click", () => this.criarBlocoNoCentro());
	}

	private desenharPlano(): void {
		// Um redesenho destrói os cards atuais e limpa o SVG. Se houvesse um arrasto em curso,
		// ele passaria a mexer num nó que não está mais na tela — melhor encerrar antes.
		if (this.arrasto.tipo !== "nenhum" && this.arrasto.tipo !== "plano") {
			this.arrasto = { tipo: "nenhum" };
			// A linha provisória é filha do SVG, que desenharSetas esvazia: sem soltar a
			// referência, o arrasto seguinte escreveria num nó já descartado.
			this.linhaProvisoria?.remove();
			this.linhaProvisoria = null;
			this.limparGuias();
			// O laço não é .cmap-bloco, então a limpeza abaixo não o pegaria: sem isto ele
			// ficaria congelado na tela para sempre se um redesenho caísse no meio do arrasto.
			this.lacoEl?.remove();
			this.lacoEl = null;
			// A caixa do grupo idem: é recriada logo abaixo a partir da seleção atual.
			this.caixaGrupoEl?.remove();
			this.caixaGrupoEl = null;
			this.plano.querySelectorAll(".cmap-bloco-alvo").forEach((el) => el.removeClass("cmap-bloco-alvo"));
			this.limparDestaqueDeAninhamento();
		}

		// Remove só os cards; o SVG das setas é reaproveitado. A caixa do grupo é redesenhada
		// no fim, junto com as classes de seleção.
		this.plano.querySelectorAll(".cmap-bloco").forEach((el) => el.remove());

		const nivel = this.nivelAtual();
		this.aplicarCamera();

		for (const bloco of nivel.blocos) {
			this.plano.appendChild(this.criarCard(bloco));
		}

		desenharSetas(this.svg, nivel.blocos, nivel.setas, {
			selecionada: this.setaSelecionada,
			aoClicar: (seta) => this.selecionarSeta(seta),
		});

		this.desenharCaixaDoGrupo();
		this.desenharEstadoVazio(nivel);
	}

	private desenharEstadoVazio(nivel: Nivel): void {
		this.raiz.querySelector(".cmap-vazio")?.remove();
		if (nivel.blocos.length > 0) return;

		const vazio = this.area.createDiv({ cls: "cmap-vazio" });
		vazio.createDiv({ cls: "cmap-vazio-titulo", text: "Tela em branco" });
		vazio.createDiv({
			cls: "cmap-vazio-texto",
			text: "Dê um duplo clique em qualquer lugar para criar um bloco.",
		});
	}

	private aplicarCamera(): void {
		const { x, y, zoom } = this.camera;
		this.plano.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
	}

	private criarCard(bloco: Bloco): HTMLElement {
		const card = createDiv({ cls: `cmap-bloco cmap-cor-${bloco.cor}` });
		card.dataset.id = bloco.id;
		card.style.left = `${bloco.x}px`;
		card.style.top = `${bloco.y}px`;
		card.style.width = `${bloco.largura}px`;
		card.style.height = `${bloco.altura}px`;
		this.marcarTamanho(card, bloco);
		if (this.selecionados.has(bloco.id)) card.addClass("cmap-bloco-selecionado");

		// O conteúdo mora num contêiner que recorta; o card em si não recorta, senão as
		// alças de seta (que ficam para fora da borda) seriam cortadas pela metade.
		const conteudo = card.createDiv({ cls: "cmap-bloco-conteudo" });

		const cabecalho = conteudo.createDiv({ cls: "cmap-bloco-cabecalho" });
		cabecalho.createDiv({ cls: "cmap-bloco-titulo", text: bloco.titulo || "Sem título" });

		if (bloco.nota) {
			const icone = cabecalho.createDiv({ cls: "cmap-bloco-nota", attr: { "aria-label": bloco.nota } });
			setIcon(icone, "file-text");
		}

		if (bloco.texto) {
			conteudo.createDiv({ cls: "cmap-bloco-texto", text: bloco.texto });
		}

		this.montarChecklistDoCard(conteudo, bloco);
		this.montarRodapeDoCard(conteudo, bloco);

		// Alça de redimensionamento no canto inferior direito.
		const alca = card.createDiv({ cls: "cmap-bloco-alca", attr: { "aria-label": "Redimensionar" } });
		alca.addEventListener("mousedown", (e) => this.iniciarRedimensionamento(e, bloco));

		// Uma alça de seta por lado, como no Canvas nativo: puxar sempre do lado que aponta
		// para o destino evita a linha dando a volta no próprio card.
		for (const lado of ["cima", "direita", "baixo", "esquerda"] as const) {
			const alcaSeta = card.createDiv({
				cls: `cmap-bloco-alca-seta cmap-alca-${lado}`,
				attr: { "aria-label": "Ligar a outro bloco" },
			});
			alcaSeta.addEventListener("mousedown", (e) => this.iniciarSeta(e, bloco, lado));
		}

		card.addEventListener("mousedown", (e) => this.iniciarArrastoDeBloco(e, bloco));
		card.addEventListener("dblclick", (e) => {
			e.stopPropagation();
			this.entrarNoBloco(bloco.id);
		});
		card.addEventListener("contextmenu", (e) => this.abrirMenuDoBloco(e, bloco));

		return card;
	}

	private montarChecklistDoCard(card: HTMLElement, bloco: Bloco): void {
		if (bloco.checklist.length === 0) return;

		const lista = card.createDiv({ cls: "cmap-bloco-checklist" });
		for (const item of bloco.checklist) {
			const linha = lista.createDiv({ cls: "cmap-bloco-check" });
			const marca = linha.createEl("input", { attr: { type: "checkbox" } });
			marca.checked = item.feito;

			// O checkbox vive dentro de um card arrastável: sem isso, clicar nele arrastaria o bloco.
			marca.addEventListener("mousedown", (e) => e.stopPropagation());
			marca.addEventListener("dblclick", (e) => e.stopPropagation());
			const texto = linha.createSpan({ cls: "cmap-bloco-check-texto", text: item.texto || "(sem texto)" });
			texto.toggleClass("cmap-bloco-check-feito", item.feito);

			marca.addEventListener("change", (e) => {
				e.stopPropagation();
				this.registrarNoHistorico(`check:${item.id}`);
				item.feito = marca.checked;
				this.aoSalvar();
				this.painel.atualizarSe(bloco);

				// Atualiza só o que mudou. Redesenhar o plano aqui destruiria este próprio
				// checkbox no meio do evento dele, tirando o foco a cada item marcado.
				texto.toggleClass("cmap-bloco-check-feito", item.feito);
				this.atualizarRodape(bloco);
			});
		}
	}

	private montarRodapeDoCard(card: HTMLElement, bloco: Bloco): void {
		const quantosFilhos = bloco.filhos.length;
		const progresso = progressoChecklist(bloco);
		if (quantosFilhos === 0 && !progresso) return;

		const rodape = card.createDiv({ cls: "cmap-bloco-rodape" });

		if (quantosFilhos > 0) {
			const total = contarDescendentes(bloco);
			const selo = rodape.createDiv({ cls: "cmap-bloco-selo" });
			setIcon(selo.createSpan(), "layers");
			// Mostra o total da subárvore quando há netos — "3 blocos" esconderia a profundidade real.
			const texto = total === quantosFilhos ? `${quantosFilhos}` : `${quantosFilhos} (${total})`;
			selo.createSpan({ text: `${texto} ${quantosFilhos === 1 ? "bloco" : "blocos"}` });
		}

		if (progresso) {
			const selo = rodape.createDiv({ cls: "cmap-bloco-selo" });
			setIcon(selo.createSpan(), "check-square");
			selo.createSpan({ text: `${progresso.feitos}/${progresso.total}` });
		}
	}

	/** Refaz só o rodapé de um card (contador de checklist), sem tocar no resto. */
	private atualizarRodape(bloco: Bloco): void {
		const conteudo = this.plano.querySelector<HTMLElement>(
			`.cmap-bloco[data-id="${bloco.id}"] .cmap-bloco-conteudo`
		);
		if (!conteudo) return;
		conteudo.querySelector(".cmap-bloco-rodape")?.remove();
		this.montarRodapeDoCard(conteudo, bloco);
	}

	// -------------------------------------------------------------------------
	// Coordenadas
	// -------------------------------------------------------------------------

	/** Converte um ponto da janela para as coordenadas do mapa (desfazendo pan e zoom). */
	private paraCoordenadasDoMapa(clienteX: number, clienteY: number): { x: number; y: number } {
		const caixa = this.area.getBoundingClientRect();
		return {
			x: (clienteX - caixa.left - this.camera.x) / this.camera.zoom,
			y: (clienteY - caixa.top - this.camera.y) / this.camera.zoom,
		};
	}

	// -------------------------------------------------------------------------
	// Eventos
	// -------------------------------------------------------------------------

	private ligarEventos(): void {
		// Os atalhos de teclado dependem do contentEl estar focado. Digitar no painel lateral
		// tira esse foco, então qualquer clique na área do mapa o devolve — senão Delete/Esc
		// param de funcionar depois da primeira edição de texto.
		this.area.addEventListener("mousedown", () => this.devolverFoco());

		this.area.addEventListener("mousedown", (e) => this.aoApertarNaArea(e));
		this.area.addEventListener("dblclick", (e) => this.aoDuploCliqueNaArea(e));
		this.area.addEventListener("wheel", (e) => this.aoRolar(e), { passive: false });
		this.area.addEventListener("contextmenu", (e) => this.abrirMenuDaArea(e));

		// Os handlers de movimento ficam no document: se o ponteiro sair da área durante
		// o arrasto, o bloco continua acompanhando em vez de travar no meio do caminho.
		document.addEventListener("mousemove", this.aoMover);
		document.addEventListener("mouseup", this.aoSoltar);
	}

	/**
	 * Devolve o foco ao contêiner da view, que é quem escuta o teclado.
	 * `preventScroll` evita o pulo de rolagem que o foco causaria em mapas grandes.
	 */
	private devolverFoco(): void {
		const focavel = this.raiz.parentElement;
		if (focavel && document.activeElement !== focavel) {
			focavel.focus({ preventScroll: true });
		}
	}

	/** Precisa ser removido no destruir da view, senão vaza handler a cada aba fechada. */
	desligarEventos(): void {
		document.removeEventListener("mousemove", this.aoMover);
		document.removeEventListener("mouseup", this.aoSoltar);
	}

	private aoApertarNaArea(e: MouseEvent): void {
		// Principal e botão do meio; o direito é menu de contexto.
		const botaoDoMeio = e.button === 1;
		if (e.button !== 0 && !botaoDoMeio) return;
		if ((e.target as HTMLElement).closest(".cmap-bloco")) return;

		// Ctrl (ou o botão do meio) move a tela; arrastar solto no fundo desenha o laço de
		// seleção. Pedido dela: selecionar vários é o gesto mais frequente no fundo, mover a
		// tela é o eventual.
		if (e.ctrlKey || e.metaKey || botaoDoMeio) {
			// O botão do meio rola a página por padrão no Chromium; sem isto o pan brigaria
			// com o auto-scroll do navegador.
			e.preventDefault();
			this.arrasto = {
				tipo: "plano",
				inicioX: e.clientX,
				inicioY: e.clientY,
				cameraX: this.camera.x,
				cameraY: this.camera.y,
			};
			this.area.addClass("cmap-area-arrastando");
			return;
		}

		const ponto = this.paraCoordenadasDoMapa(e.clientX, e.clientY);
		const somar = e.shiftKey;

		if (!somar) {
			this.limparSelecao();
			this.desenharPlano();
		}

		this.arrasto = {
			tipo: "laco",
			inicioX: ponto.x,
			inicioY: ponto.y,
			atualX: ponto.x,
			atualY: ponto.y,
			anteriores: new Set(somar ? this.selecionados : []),
		};
	}

	private aoDuploCliqueNaArea(e: MouseEvent): void {
		if ((e.target as HTMLElement).closest(".cmap-bloco")) return;
		const ponto = this.paraCoordenadasDoMapa(e.clientX, e.clientY);
		this.criarBloco(ponto.x, ponto.y);
	}

	private aoRolar(e: WheelEvent): void {
		// Ctrl/⌘ + roda é o gesto de zoom (e o pinch do trackpad chega como ctrlKey).
		if (!e.ctrlKey && !e.metaKey) {
			this.camera.x -= e.deltaX;
			this.camera.y -= e.deltaY;
			this.aplicarCamera();
			e.preventDefault();
			return;
		}

		e.preventDefault();
		const anterior = this.camera.zoom;
		const novo = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, anterior * (1 - e.deltaY * PASSO_ZOOM)));
		if (novo === anterior) return;

		// Zoom ancorado no ponteiro: o ponto sob o cursor fica parado.
		const caixa = this.area.getBoundingClientRect();
		const px = e.clientX - caixa.left;
		const py = e.clientY - caixa.top;
		this.camera.x = px - ((px - this.camera.x) / anterior) * novo;
		this.camera.y = py - ((py - this.camera.y) / anterior) * novo;
		this.camera.zoom = novo;
		this.aplicarCamera();
	}

	private iniciarArrastoDeBloco(e: MouseEvent, bloco: Bloco): void {
		// Ctrl move a TELA, mesmo com o ponteiro sobre um card — num mapa cheio os cards
		// cobrem quase tudo, e o pan ficaria preso aos vãos entre eles.
		if (e.ctrlKey || e.metaKey || e.button === 1) {
			e.stopPropagation();
			e.preventDefault();
			this.arrasto = {
				tipo: "plano",
				inicioX: e.clientX,
				inicioY: e.clientY,
				cameraX: this.camera.x,
				cameraY: this.camera.y,
			};
			this.area.addClass("cmap-area-arrastando");
			return;
		}

		if (e.button !== 0) return;
		// As alças têm o próprio handler; sem isso o bloco andaria junto ao redimensionar.
		if ((e.target as HTMLElement).closest(".cmap-bloco-alca, .cmap-bloco-alca-seta")) return;
		if ((e.target as HTMLElement).closest("input")) return;

		e.stopPropagation();
		this.selecionarBloco(bloco, e.shiftKey);

		// Se ele faz parte de uma seleção, o grupo inteiro anda junto. A distância de cada um
		// para o bloco puxado é fixada agora, e o movimento apenas a reaplica — assim o
		// encaixe age só sobre o puxado e o layout do grupo não se deforma.
		const acompanhantes = this.blocosSelecionados()
			.filter((b) => b.id !== bloco.id)
			.map((b) => ({ bloco: b, deslocX: b.x - bloco.x, deslocY: b.y - bloco.y }));

		this.arrasto = {
			tipo: "bloco",
			bloco,
			inicioX: e.clientX,
			inicioY: e.clientY,
			blocoX: bloco.x,
			blocoY: bloco.y,
			acompanhantes,
			moveu: false,
		};
	}

	private iniciarRedimensionamento(e: MouseEvent, bloco: Bloco): void {
		if (e.button !== 0) return;
		e.stopPropagation();
		e.preventDefault();

		this.arrasto = {
			tipo: "redimensionar",
			// Como no arrasto: o passo de desfazer nasce no primeiro movimento real, para um
			// clique na alça não gastar um passo que não muda nada.
			registrou: false,
			bloco,
			inicioX: e.clientX,
			inicioY: e.clientY,
			largura: bloco.largura,
			altura: bloco.altura,
		};
	}

	private iniciarSeta(e: MouseEvent, bloco: Bloco, lado: Lado): void {
		if (e.button !== 0) return;
		e.stopPropagation();
		e.preventDefault();

		const ponto = this.paraCoordenadasDoMapa(e.clientX, e.clientY);
		this.arrasto = { tipo: "seta", de: bloco, lado, x: ponto.x, y: ponto.y };
		this.criarLinhaProvisoria();
	}

	private aoMover = (e: MouseEvent): void => {
		switch (this.arrasto.tipo) {
			case "plano": {
				this.camera.x = this.arrasto.cameraX + (e.clientX - this.arrasto.inicioX);
				this.camera.y = this.arrasto.cameraY + (e.clientY - this.arrasto.inicioY);
				this.aplicarCamera();
				break;
			}
			case "bloco": {
				const dx = (e.clientX - this.arrasto.inicioX) / this.camera.zoom;
				const dy = (e.clientY - this.arrasto.inicioY) / this.camera.zoom;
				if (!this.arrasto.moveu && Math.hypot(dx, dy) * this.camera.zoom < LIMIAR_ARRASTO) break;

				// O ponto de retorno é o estado ANTES do primeiro movimento real: registrar no
				// mousedown criaria um passo mesmo para um clique que só seleciona.
				if (!this.arrasto.moveu) this.registrarNoHistorico(`mover:${this.arrasto.bloco.id}:${Date.now()}`);

				this.arrasto.moveu = true;
				const bloco = this.arrasto.bloco;
				const livreX = Math.round(this.arrasto.blocoX + dx);
				const livreY = Math.round(this.arrasto.blocoY + dy);

				// Alt segura o posicionamento livre, para quando ela quiser um lugar
				// que o encaixe insiste em corrigir.
				if (e.altKey) {
					bloco.x = livreX;
					bloco.y = livreY;
					this.limparGuias();
				} else {
					const encaixe = encaixarAoMover(
						livreX,
						livreY,
						bloco.largura,
						bloco.altura,
						this.vizinhosDe(bloco)
					);
					bloco.x = encaixe.x;
					bloco.y = encaixe.y;
					this.desenharGuias(encaixe.guias);
				}

				// O grupo reaplica a distância fixada no início do arrasto.
				for (const acompanhante of this.arrasto.acompanhantes) {
					acompanhante.bloco.x = bloco.x + acompanhante.deslocX;
					acompanhante.bloco.y = bloco.y + acompanhante.deslocY;
					this.posicionarCard(acompanhante.bloco);
				}

				this.posicionarCard(bloco);
				this.destacarAlvoDeAninhamento(bloco);
				this.redesenharSetas();
				break;
			}
			case "laco": {
				const ponto = this.paraCoordenadasDoMapa(e.clientX, e.clientY);
				this.arrasto.atualX = ponto.x;
				this.arrasto.atualY = ponto.y;
				this.atualizarLaco();
				break;
			}
			case "escalar-grupo": {
				this.escalarGrupo(e);
				break;
			}
			case "redimensionar": {
				const dx = (e.clientX - this.arrasto.inicioX) / this.camera.zoom;
				const dy = (e.clientY - this.arrasto.inicioY) / this.camera.zoom;
				const alvo = this.arrasto.bloco;

				if (!this.arrasto.registrou) {
					if (Math.hypot(dx, dy) * this.camera.zoom < LIMIAR_ARRASTO) break;
					this.registrarNoHistorico(`tamanho:${alvo.id}:${Date.now()}`);
					this.arrasto.registrou = true;
				}

				const livreLargura = Math.round(Math.max(LARGURA_MINIMA, this.arrasto.largura + dx));
				const livreAltura = Math.round(Math.max(ALTURA_MINIMA, this.arrasto.altura + dy));

				if (e.altKey) {
					alvo.largura = livreLargura;
					alvo.altura = livreAltura;
					this.limparGuias();
				} else {
					const encaixe = encaixarAoRedimensionar(
						alvo,
						livreLargura,
						livreAltura,
						this.vizinhosDe(alvo)
					);
					alvo.largura = encaixe.largura;
					alvo.altura = encaixe.altura;
					this.desenharGuias(encaixe.guias);
				}

				this.posicionarCard(alvo);
				this.redesenharSetas();
				break;
			}
			case "seta": {
				const ponto = this.paraCoordenadasDoMapa(e.clientX, e.clientY);
				this.arrasto.x = ponto.x;
				this.arrasto.y = ponto.y;
				this.atualizarLinhaProvisoria();
				this.destacarAlvoDaSeta(e);
				break;
			}
		}
	};

	private aoSoltar = (e: MouseEvent): void => {
		// Só os botões que iniciam arrasto o encerram: soltar o direito no meio de um pan
		// com o botão do meio não pode matar o gesto que ainda está em curso.
		if (e.button !== 0 && e.button !== 1) return;

		const arrasto = this.arrasto;
		this.arrasto = { tipo: "nenhum" };
		this.area.removeClass("cmap-area-arrastando");
		this.limparGuias();

		// Clique sem arrasto num bloco de uma seleção múltipla reduz a seleção a ele. É como o
		// Figma e o Canvas se comportam, e é o único caminho para voltar a editar um só —
		// `selecionarBloco` preserva o conjunto no mousedown justamente para permitir arrastar
		// o grupo, então a redução tem que acontecer aqui, quando se sabe que não houve gesto.
		if (arrasto.tipo === "bloco" && !arrasto.moveu && !e.shiftKey && this.selecionados.size > 1) {
			this.selecionados = new Set([arrasto.bloco.id]);
			this.painel.mostrar(arrasto.bloco);
			this.aplicarClassesDeSelecao();
			return;
		}

		if (arrasto.tipo === "bloco" && arrasto.moveu) {
			this.limparDestaqueDeAninhamento();

			// Soltar um bloco inteiramente dentro de outro o move para dentro dele. Cada
			// acompanhante é testado por conta própria: arrastar um grupo não deve levar para
			// dentro um bloco que ficou visivelmente de fora.
			const alvo = alvoDeAninhamento(arrasto.bloco, this.vizinhosDe(arrasto.bloco));
			if (alvo) {
				const movidos = [arrasto.bloco, ...arrasto.acompanhantes.map((a) => a.bloco)].filter(
					(b) => b.id === arrasto.bloco.id || contem(alvo, b)
				);
				this.aninhar(movidos, alvo);
				return;
			}

			this.aoSalvar();
		} else if (arrasto.tipo === "redimensionar") {
			this.aoSalvar();
		} else if (arrasto.tipo === "seta") {
			this.finalizarSeta(arrasto.de, e);
		} else if (arrasto.tipo === "laco") {
			this.finalizarLaco();
		} else if (arrasto.tipo === "escalar-grupo") {
			this.aoSalvar();
		}
	};

	/** Os outros blocos do nível: com quem o bloco em movimento pode se alinhar. */
	private vizinhosDe(bloco: Bloco): Bloco[] {
		return this.nivelAtual().blocos.filter((b) => b.id !== bloco.id);
	}

	// -------------------------------------------------------------------------
	// Aninhamento por arrasto
	// -------------------------------------------------------------------------

	/** Marca o bloco que receberia o arrastado se ele fosse solto agora. */
	private destacarAlvoDeAninhamento(movel: Bloco): void {
		this.limparDestaqueDeAninhamento();
		const alvo = alvoDeAninhamento(movel, this.vizinhosDe(movel));
		if (!alvo) return;
		this.plano
			.querySelector(`.cmap-bloco[data-id="${alvo.id}"]`)
			?.addClass("cmap-bloco-recebendo");
	}

	private limparDestaqueDeAninhamento(): void {
		this.plano.querySelectorAll(".cmap-bloco-recebendo").forEach((el) => el.removeClass("cmap-bloco-recebendo"));
	}

	/**
	 * Move blocos para dentro de `pai`: eles saem deste nível e passam a ser filhos dele,
	 * ganhando posição livre no plano de dentro.
	 *
	 * As setas entre os movidos vão junto — descrevem a relação entre eles, que continua
	 * valendo lá dentro. As que ligavam um movido a um bloco que ficou para trás são
	 * descartadas: os dois lados passam a viver em níveis diferentes, e uma seta não
	 * atravessa níveis.
	 */
	private aninhar(movidos: Bloco[], pai: Bloco): void {
		const nivel = this.nivelAtual();
		const ids = new Set(movidos.map((b) => b.id));

		// Um bloco não pode entrar em si mesmo: viraria um ciclo. `alvoDeAninhamento` já exclui
		// o próprio bloco puxado, mas o alvo pode ser um dos acompanhantes do grupo — ela
		// selecionou A e B e arrastou A para dentro de B.
		if (ids.has(pai.id)) {
			// O arrasto em si vale: os blocos ficam onde ela soltou, só não aninham.
			this.aoSalvar();
			new Notice("Um bloco selecionado não pode receber os outros. Tire-o da seleção e arraste de novo.");
			return;
		}

		for (let i = nivel.blocos.length - 1; i >= 0; i--) {
			if (ids.has(nivel.blocos[i].id)) nivel.blocos.splice(i, 1);
		}

		// Preserva as setas internas ao grupo (descrevem a relação entre os movidos, que
		// continua valendo lá dentro); descarta as que cruzariam níveis, porque os dois lados
		// passam a viver em planos diferentes.
		const setasQueVao: Seta[] = [];
		let setasPerdidas = 0;
		for (let i = nivel.setas.length - 1; i >= 0; i--) {
			const seta = nivel.setas[i];
			const de = ids.has(seta.de);
			const para = ids.has(seta.para);
			if (de && para) {
				setasQueVao.unshift(seta);
				nivel.setas.splice(i, 1);
			} else if (de || para) {
				nivel.setas.splice(i, 1);
				setasPerdidas++;
			}
		}

		for (const bloco of movidos) {
			const posicao = posicaoLivreDentro(bloco, pai.filhos);
			bloco.x = posicao.x;
			bloco.y = posicao.y;
			pai.filhos.push(bloco);
		}

		pai.setas.push(...setasQueVao);

		this.limparSelecao();
		this.aoSalvar();
		this.desenhar();

		const quantos = movidos.length;
		const nomePai = pai.titulo || "bloco";
		const oQueFoi =
			quantos === 1
				? `"${movidos[0].titulo || "Bloco"}" foi para dentro de "${nomePai}"`
				: `${quantos} blocos foram para dentro de "${nomePai}"`;

		// Seta apagada some sem deixar rastro na tela: mesmo com Ctrl+Z, ela precisa saber que
		// aconteceu para decidir se quer voltar.
		const sobreSetas =
			setasPerdidas > 0
				? `. ${setasPerdidas} ${setasPerdidas === 1 ? "seta foi desfeita" : "setas foram desfeitas"} (ligavam blocos que agora estão em níveis diferentes)`
				: "";

		new Notice(`${oQueFoi}${sobreSetas}.`);
	}

	// -------------------------------------------------------------------------
	// Laço de seleção
	// -------------------------------------------------------------------------

	/** Redesenha o retângulo do laço e marca quem está dentro dele. */
	private atualizarLaco(): void {
		if (this.arrasto.tipo !== "laco") return;
		const { inicioX, inicioY, atualX, atualY, anteriores } = this.arrasto;

		const x = Math.min(inicioX, atualX);
		const y = Math.min(inicioY, atualY);
		const largura = Math.abs(atualX - inicioX);
		const altura = Math.abs(atualY - inicioY);

		if (!this.lacoEl) {
			this.lacoEl = this.plano.createDiv({ cls: "cmap-laco" });
		}
		this.lacoEl.style.left = `${x}px`;
		this.lacoEl.style.top = `${y}px`;
		this.lacoEl.style.width = `${largura}px`;
		this.lacoEl.style.height = `${altura}px`;

		// Basta o laço TOCAR o bloco: exigir contenção total obrigaria a envolver blocos
		// grandes por inteiro, o que raramente cabe na tela.
		this.selecionados = new Set(anteriores);
		for (const bloco of this.nivelAtual().blocos) {
			const toca =
				bloco.x < x + largura &&
				bloco.x + bloco.largura > x &&
				bloco.y < y + altura &&
				bloco.y + bloco.altura > y;
			if (toca) this.selecionados.add(bloco.id);
		}

		this.aplicarClassesDeSelecao();
	}

	private finalizarLaco(): void {
		this.lacoEl?.remove();
		this.lacoEl = null;
		this.painel.mostrar(this.blocoUnicoSelecionado());
	}

	/**
	 * Desenha as linhas-guia do encaixe. Elas vivem no mesmo SVG das setas, então usam
	 * coordenadas do mapa e acompanham pan e zoom sem cálculo extra.
	 */
	private desenharGuias(guias: Guia[]): void {
		this.limparGuias();
		if (guias.length === 0) return;

		for (const guia of guias) {
			const linha = document.createElementNS(NS_SVG, "line");
			linha.classList.add("cmap-guia");

			if (guia.orientacao === "vertical") {
				linha.setAttribute("x1", String(guia.posicao));
				linha.setAttribute("x2", String(guia.posicao));
				linha.setAttribute("y1", String(guia.de));
				linha.setAttribute("y2", String(guia.ate));
			} else {
				linha.setAttribute("y1", String(guia.posicao));
				linha.setAttribute("y2", String(guia.posicao));
				linha.setAttribute("x1", String(guia.de));
				linha.setAttribute("x2", String(guia.ate));
			}

			this.svg.appendChild(linha);
			this.guias.push(linha);
		}
	}

	private limparGuias(): void {
		for (const linha of this.guias) linha.remove();
		this.guias = [];
	}

	/** Move só o card no DOM, sem redesenhar tudo — arrasto precisa ser barato. */
	private posicionarCard(bloco: Bloco): void {
		const card = this.plano.querySelector<HTMLElement>(`.cmap-bloco[data-id="${bloco.id}"]`);
		if (!card) return;
		card.style.left = `${bloco.x}px`;
		card.style.top = `${bloco.y}px`;
		card.style.width = `${bloco.largura}px`;
		card.style.height = `${bloco.altura}px`;
		this.marcarTamanho(card, bloco);
	}

	/**
	 * Marca no card em que faixa de tamanho ele está, para o CSS esconder o que não cabe.
	 *
	 * Um bloco pode ser uma barra lateral de 60px ou um cabeçalho de 40px de altura — nesses
	 * formatos, texto e selos não cabem e estourariam o card. A alternativa seria consultar o
	 * tamanho renderizado, mas isso força layout a cada quadro do arrasto; aqui os números do
	 * modelo bastam.
	 */
	private marcarTamanho(card: HTMLElement, bloco: Bloco): void {
		const estreito = bloco.largura < 120;
		const baixo = bloco.altura < 64;
		const minusculo = bloco.largura < 72 || bloco.altura < 40;

		// A faixa é guardada no próprio elemento: `posicionarCard` roda a cada quadro do
		// arrasto, e trocar classes que mexem em writing-mode/display forçaria relayout da
		// subárvore toda. Como a faixa quase nunca muda, o caso comum sai de graça.
		const faixa = `${estreito}${baixo}${minusculo}`;
		if (card.dataset.faixa === faixa) return;
		card.dataset.faixa = faixa;

		card.toggleClass("cmap-bloco-estreito", estreito);
		card.toggleClass("cmap-bloco-baixo", baixo);
		card.toggleClass("cmap-bloco-minusculo", minusculo);
	}

	private redesenharSetas(): void {
		const nivel = this.nivelAtual();
		desenharSetas(this.svg, nivel.blocos, nivel.setas, {
			selecionada: this.setaSelecionada,
			aoClicar: (seta) => this.selecionarSeta(seta),
		});

		// desenharSetas esvazia o SVG, e as guias moram nele: sem reinserir, elas piscariam
		// e sumiriam a cada movimento do arrasto.
		for (const linha of this.guias) this.svg.appendChild(linha);
		if (this.linhaProvisoria) this.svg.appendChild(this.linhaProvisoria);
	}

	// -------------------------------------------------------------------------
	// Seta em construção
	// -------------------------------------------------------------------------

	private criarLinhaProvisoria(): void {
		this.linhaProvisoria = document.createElementNS(NS_SVG, "path");
		this.linhaProvisoria.classList.add("cmap-seta-provisoria");
		this.svg.appendChild(this.linhaProvisoria);
	}

	private atualizarLinhaProvisoria(): void {
		if (this.arrasto.tipo !== "seta" || !this.linhaProvisoria) return;
		// Sai da borda do lado que ela pegou, não do centro do card: é o que dá a sensação
		// de estar puxando o fio daquele ponto.
		const origem = pontoNoLado(this.arrasto.de, this.arrasto.lado);
		this.linhaProvisoria.setAttribute(
			"d",
			`M ${origem.x} ${origem.y} L ${this.arrasto.x} ${this.arrasto.y}`
		);
	}

	private destacarAlvoDaSeta(e: MouseEvent): void {
		this.plano.querySelectorAll(".cmap-bloco-alvo").forEach((el) => el.removeClass("cmap-bloco-alvo"));
		const alvo = this.cardSob(e);
		if (alvo && this.arrasto.tipo === "seta" && alvo.dataset.id !== this.arrasto.de.id) {
			alvo.addClass("cmap-bloco-alvo");
		}
	}

	private finalizarSeta(de: Bloco, e: MouseEvent): void {
		this.linhaProvisoria?.remove();
		this.linhaProvisoria = null;
		this.plano.querySelectorAll(".cmap-bloco-alvo").forEach((el) => el.removeClass("cmap-bloco-alvo"));

		const alvo = this.cardSob(e);
		const idAlvo = alvo?.dataset.id;
		if (!idAlvo || idAlvo === de.id) {
			this.redesenharSetas();
			return;
		}

		const nivel = this.nivelAtual();
		const jaExiste = nivel.setas.some((s) => s.de === de.id && s.para === idAlvo);
		if (jaExiste) {
			this.redesenharSetas();
			return;
		}

		const idSeta = novoId();
		this.registrarNoHistorico(`seta:${idSeta}`);
		nivel.setas.push({ id: idSeta, de: de.id, para: idAlvo, rotulo: "" });
		this.aoSalvar();
		this.redesenharSetas();
	}

	/** Card sob o ponteiro. Usa elementFromPoint porque o alvo do evento é a linha provisória. */
	private cardSob(e: MouseEvent): HTMLElement | null {
		const elementos = document.elementsFromPoint(e.clientX, e.clientY);
		for (const el of elementos) {
			const card = (el as HTMLElement).closest?.(".cmap-bloco");
			if (card) return card as HTMLElement;
		}
		return null;
	}

	// -------------------------------------------------------------------------
	// Seleção e edição
	// -------------------------------------------------------------------------

	/**
	 * Seleciona um bloco. Com `somar` (Shift), acrescenta ou tira da seleção em vez de
	 * substituí-la — é o gesto de montar um conjunto clicando um a um.
	 */
	private selecionarBloco(bloco: Bloco, somar = false): void {
		if (somar) {
			if (this.selecionados.has(bloco.id)) this.selecionados.delete(bloco.id);
			else this.selecionados.add(bloco.id);
		} else {
			// Clicar num bloco já selecionado preserva o conjunto: senão, começar a arrastar
			// vários desfaria a seleção justamente no momento de movê-los.
			if (!this.selecionados.has(bloco.id)) {
				this.selecionados.clear();
				this.selecionados.add(bloco.id);
			}
		}

		this.setaSelecionada = null;
		this.painel.mostrar(this.blocoUnicoSelecionado());
		this.aplicarClassesDeSelecao();
		this.redesenharSetas();
	}

	/** Reflete a seleção no DOM sem redesenhar os cards. */
	private aplicarClassesDeSelecao(): void {
		this.plano.querySelectorAll<HTMLElement>(".cmap-bloco").forEach((card) => {
			card.toggleClass("cmap-bloco-selecionado", this.selecionados.has(card.dataset.id ?? ""));
		});
		this.desenharCaixaDoGrupo();
	}

	// -------------------------------------------------------------------------
	// Caixa do grupo (escala proporcional de vários blocos)
	// -------------------------------------------------------------------------

	/** Retângulo que envolve os blocos selecionados, ou null com menos de dois. */
	private caixaDaSelecao(): { x: number; y: number; largura: number; altura: number } | null {
		const blocos = this.blocosSelecionados();
		if (blocos.length < 2) return null;

		const x = Math.min(...blocos.map((b) => b.x));
		const y = Math.min(...blocos.map((b) => b.y));
		const direita = Math.max(...blocos.map((b) => b.x + b.largura));
		const baixo = Math.max(...blocos.map((b) => b.y + b.altura));

		return { x, y, largura: direita - x, altura: baixo - y };
	}

	/**
	 * Desenha a moldura em volta da seleção múltipla, com a alça que escala o conjunto.
	 * Some quando há menos de dois blocos — com um só, a alça do próprio card já resolve.
	 */
	private desenharCaixaDoGrupo(): void {
		const caixa = this.caixaDaSelecao();

		if (!caixa) {
			this.caixaGrupoEl?.remove();
			this.caixaGrupoEl = null;
			return;
		}

		if (!this.caixaGrupoEl) {
			this.caixaGrupoEl = this.plano.createDiv({ cls: "cmap-grupo" });
			const alca = this.caixaGrupoEl.createDiv({
				cls: "cmap-grupo-alca",
				attr: { "aria-label": "Redimensionar a seleção" },
			});
			alca.addEventListener("mousedown", (e) => this.iniciarEscalaDeGrupo(e));
		}

		this.caixaGrupoEl.style.left = `${caixa.x}px`;
		this.caixaGrupoEl.style.top = `${caixa.y}px`;
		this.caixaGrupoEl.style.width = `${caixa.largura}px`;
		this.caixaGrupoEl.style.height = `${caixa.altura}px`;
	}

	private iniciarEscalaDeGrupo(e: MouseEvent): void {
		if (e.button !== 0) return;
		e.stopPropagation();
		e.preventDefault();

		const caixa = this.caixaDaSelecao();
		if (!caixa) return;

		this.arrasto = {
			tipo: "escalar-grupo",
			inicioX: e.clientX,
			inicioY: e.clientY,
			// O histórico só é tocado no primeiro movimento real: um clique na alça sem
			// arrastar não muda nada, e gastaria um passo que parece não fazer nada ao desfazer.
			registrou: false,
			caixa,
			// Cada bloco guarda seu estado original: aplicar a escala sobre o valor corrente
			// acumularia erro de arredondamento a cada quadro do arrasto.
			originais: this.blocosSelecionados().map((bloco) => ({
				bloco,
				x: bloco.x,
				y: bloco.y,
				largura: bloco.largura,
				altura: bloco.altura,
			})),
		};
	}

	/**
	 * Escala o conjunto a partir do canto superior esquerdo da caixa, que fica parado.
	 *
	 * Tamanhos E distâncias entre os blocos crescem juntos — o layout inteiro aumenta como
	 * uma coisa só, que é o que ela pediu. Sem `Shift`, os dois eixos usam o mesmo fator (o
	 * maior dos dois), preservando a proporção do desenho; com `Shift`, cada eixo é livre.
	 */
	private escalarGrupo(e: MouseEvent): void {
		if (this.arrasto.tipo !== "escalar-grupo") return;
		const { caixa, originais } = this.arrasto;

		const dx = (e.clientX - this.arrasto.inicioX) / this.camera.zoom;
		const dy = (e.clientY - this.arrasto.inicioY) / this.camera.zoom;

		if (!this.arrasto.registrou) {
			if (Math.hypot(dx, dy) * this.camera.zoom < LIMIAR_ARRASTO) return;
			this.registrarNoHistorico(`escalar:${Date.now()}`);
			this.arrasto.registrou = true;
		}

		let fatorX = (caixa.largura + dx) / caixa.largura;
		let fatorY = (caixa.altura + dy) / caixa.altura;

		if (!e.shiftKey) {
			const uniforme = Math.max(fatorX, fatorY);
			fatorX = uniforme;
			fatorY = uniforme;
		}

		// O grupo inteiro para de encolher quando o MENOR bloco chega ao mínimo. Limitar cada
		// bloco por si deformaria o layout: os pequenos travariam no piso enquanto os grandes
		// continuariam encolhendo, e as proporções entre eles — que é o desenho — se perderiam.
		const pisoX = Math.max(...originais.map((o) => LARGURA_MINIMA / o.largura));
		const pisoY = Math.max(...originais.map((o) => ALTURA_MINIMA / o.altura));
		fatorX = Math.max(fatorX, pisoX);
		fatorY = Math.max(fatorY, pisoY);

		for (const original of originais) {
			const { bloco } = original;
			bloco.x = Math.round(caixa.x + (original.x - caixa.x) * fatorX);
			bloco.y = Math.round(caixa.y + (original.y - caixa.y) * fatorY);
			bloco.largura = Math.round(original.largura * fatorX);
			bloco.altura = Math.round(original.altura * fatorY);
			this.posicionarCard(bloco);
		}

		this.desenharCaixaDoGrupo();
		this.redesenharSetas();
	}

	private selecionarSeta(seta: Seta): void {
		this.setaSelecionada = seta.id;
		this.selecionados.clear();
		this.painel.mostrar(null);
		this.aplicarClassesDeSelecao();
		this.redesenharSetas();
	}

	private criarBloco(x: number, y: number): void {
		const bloco = novoBloco(Math.round(x), Math.round(y));
		this.registrarNoHistorico(`criar:${bloco.id}`);
		this.nivelAtual().blocos.push(bloco);
		this.aoSalvar();
		this.desenhar();
		this.selecionarBloco(bloco);
	}

	/** Cria um bloco no centro visível da área — usado pelo botão "+ Bloco". */
	private criarBlocoNoCentro(): void {
		const caixa = this.area.getBoundingClientRect();
		const centro = this.paraCoordenadasDoMapa(caixa.left + caixa.width / 2, caixa.top + caixa.height / 2);
		// Desconta metade do card para o novo bloco nascer centrado, não com o canto no centro.
		this.criarBloco(centro.x - LARGURA_PADRAO / 2, centro.y - ALTURA_PADRAO / 2);
	}

	/**
	 * Exclui o bloco, confirmando antes quando há algo a perder. Um bloco com filhos leva
	 * a subárvore inteira junto, e o que some não está visível na tela para ela conferir —
	 * mas pedir confirmação para um card vazio recém-criado só atrapalharia. (Desde a 0.8.0
	 * há Ctrl+Z, então a confirmação é sobre o susto, não sobre a irreversibilidade.)
	 */
	private pedirExclusao(alvo: Bloco | Bloco[]): void {
		const blocos = Array.isArray(alvo) ? alvo : [alvo];
		if (blocos.length === 0) return;

		const descendentes = blocos.reduce((soma, b) => soma + contarDescendentes(b), 0);
		const temConteudo =
			descendentes > 0 ||
			blocos.length > 1 ||
			blocos.some((b) => b.texto.trim() !== "" || b.checklist.length > 0);

		if (!temConteudo) {
			this.excluirBlocos(blocos);
			return;
		}

		const detalhe =
			descendentes > 0
				? ` Isso apaga também ${descendentes} ${descendentes === 1 ? "bloco que está" : "blocos que estão"} dentro ${blocos.length === 1 ? "dele" : "deles"}.`
				: "";

		const pergunta =
			blocos.length === 1
				? `Excluir "${blocos[0].titulo || "Sem título"}"?`
				: `Excluir ${blocos.length} blocos?`;

		new ModalConfirmar(
			this.app,
			blocos.length === 1 ? "Excluir bloco" : "Excluir blocos",
			`${pergunta}${detalhe}`,
			() => this.excluirBlocos(blocos)
		).open();
	}

	private excluirBlocos(blocos: Bloco[]): void {
		const nivel = this.nivelAtual();
		const ids = new Set(blocos.map((b) => b.id));

		this.registrarNoHistorico(`excluir:${Date.now()}`);

		// Filtra por id, não por identidade: a referência pode ser de uma árvore anterior
		// (arquivo recarregado), e aí remover pelo objeto não acharia nada e falharia calado.
		for (let i = nivel.blocos.length - 1; i >= 0; i--) {
			if (ids.has(nivel.blocos[i].id)) nivel.blocos.splice(i, 1);
		}

		// Sem isso sobrariam setas apontando para um bloco que não existe mais.
		this.removerSetas((s) => ids.has(s.de) || ids.has(s.para));

		for (const id of ids) {
			this.painel.fecharSe(id);
			this.selecionados.delete(id);
		}

		this.aoSalvar();
		this.desenhar();
	}

	private duplicarBloco(bloco: Bloco): void {
		const copia = this.clonar(bloco);
		copia.x += 24;
		copia.y += 24;
		this.registrarNoHistorico(`duplicar:${copia.id}`);
		this.nivelAtual().blocos.push(copia);
		this.aoSalvar();
		this.desenhar();
		this.selecionarBloco(copia);
	}

	/**
	 * Copia profunda com ids novos em toda a subárvore. Reaproveitar ids faria dois blocos
	 * diferentes responderem pelo mesmo id e a navegação entraria no bloco errado.
	 */
	private clonar(bloco: Bloco): Bloco {
		const mapaDeIds = new Map<string, string>();

		const clonarRecursivo = (original: Bloco): Bloco => {
			const id = novoId();
			mapaDeIds.set(original.id, id);
			const filhos = original.filhos.map(clonarRecursivo);

			return {
				...original,
				id,
				checklist: original.checklist.map((i) => ({ ...i, id: novoId() })),
				filhos,
				// As setas internas religam pelos ids novos dos filhos.
				setas: original.setas
					.filter((s) => mapaDeIds.has(s.de) && mapaDeIds.has(s.para))
					.map((s) => ({
						id: novoId(),
						de: mapaDeIds.get(s.de) as string,
						para: mapaDeIds.get(s.para) as string,
						rotulo: s.rotulo,
					})),
			};
		};

		return clonarRecursivo(bloco);
	}

	// -------------------------------------------------------------------------
	// Menus de contexto
	// -------------------------------------------------------------------------

	private abrirMenuDaArea(e: MouseEvent): void {
		if ((e.target as HTMLElement).closest(".cmap-bloco")) return;
		e.preventDefault();

		const ponto = this.paraCoordenadasDoMapa(e.clientX, e.clientY);
		const menu = new Menu();

		menu.addItem((item) =>
			item
				.setTitle("Novo bloco aqui")
				.setIcon("plus")
				.onClick(() => this.criarBloco(ponto.x, ponto.y))
		);

		if (this.setaSelecionada) {
			menu.addItem((item) =>
				item
					.setTitle("Excluir seta selecionada")
					.setIcon("trash-2")
					.onClick(() => this.excluirSetaSelecionada())
			);
		}

		if (this.caminho.length > 0) {
			menu.addSeparator();
			menu.addItem((item) =>
				item
					.setTitle("Voltar um nível")
					.setIcon("arrow-left")
					.onClick(() => this.voltar())
			);
		}

		menu.showAtMouseEvent(e);
	}

	private abrirMenuDoBloco(e: MouseEvent, bloco: Bloco): void {
		e.preventDefault();
		e.stopPropagation();
		this.selecionarBloco(bloco);

		// Com vários selecionados o menu age sobre o conjunto — clicar com o direito em um
		// deles não é motivo para descartar a seleção que ela acabou de montar.
		const alvos = this.selecionados.has(bloco.id) ? this.blocosSelecionados() : [bloco];
		const varios = alvos.length > 1;

		const menu = new Menu();

		if (!varios) {
			menu.addItem((item) =>
				item
					.setTitle("Entrar no bloco")
					.setIcon("corner-down-right")
					.onClick(() => this.entrarNoBloco(bloco.id))
			);

			menu.addItem((item) =>
				item
					.setTitle("Duplicar")
					.setIcon("copy")
					.onClick(() => this.duplicarBloco(bloco))
			);

			menu.addSeparator();
		}

		menu.addItem((item) => {
			item.setTitle(varios ? `Cor dos ${alvos.length} blocos` : "Cor").setIcon("palette");
			const submenu = (item as unknown as { setSubmenu: () => Menu }).setSubmenu();
			for (const cor of Object.keys(ROTULO_DA_COR) as (keyof typeof ROTULO_DA_COR)[]) {
				submenu.addItem((sub) =>
					sub
						.setTitle(ROTULO_DA_COR[cor])
						.setChecked(alvos.every((b) => b.cor === cor))
						.onClick(() => {
							this.registrarNoHistorico(`cor:${Date.now()}`);
							for (const alvo of alvos) alvo.cor = cor;
							this.aoSalvar();
							this.desenharPlano();
						})
				);
			}
		});

		// Vincular nota mora só aqui, não no painel: ela pediu para tirar de lá por ser fácil
		// de acionar sem querer. No menu ela é uma escolha deliberada. Vincular é sempre de um
		// bloco só, então some quando há vários selecionados.
		if (!varios) {
			if (bloco.nota) {
				menu.addItem((item) =>
					item
						.setTitle("Abrir nota vinculada")
						.setIcon("file-text")
						.onClick(() => this.abrirNota(bloco.nota))
				);
				menu.addItem((item) =>
					item
						.setTitle("Desvincular nota")
						.setIcon("unlink")
						.onClick(() => {
							this.registrarNoHistorico(`nota:${bloco.id}:${Date.now()}`);
							bloco.nota = null;
							this.aoSalvar();
							this.desenharPlano();
						})
				);
			} else {
				menu.addItem((item) =>
					item
						.setTitle("Vincular a uma nota…")
						.setIcon("link")
						.onClick(() => {
							new SeletorNota(this.app, (arquivo) => {
								this.registrarNoHistorico(`nota:${bloco.id}:${Date.now()}`);
								bloco.nota = arquivo.path;
								this.aoSalvar();
								this.desenharPlano();
							}).open();
						})
				);
			}
		}

		menu.addSeparator();

		menu.addItem((item) =>
			item
				.setTitle(varios ? `Excluir ${alvos.length} blocos` : "Excluir")
				.setIcon("trash-2")
				.onClick(() => this.pedirExclusao(alvos))
		);

		menu.showAtMouseEvent(e);
	}

	private excluirSetaSelecionada(): void {
		if (!this.setaSelecionada) return;
		const id = this.setaSelecionada;
		this.registrarNoHistorico(`excluir-seta:${id}`);
		this.removerSetas((s) => s.id === id);
		this.setaSelecionada = null;
		this.aoSalvar();
		this.desenharPlano();
	}

	private abrirNota(caminho: string | null): void {
		if (!caminho) return;
		const arquivo = this.app.vault.getAbstractFileByPath(caminho);
		if (arquivo instanceof TFile) {
			this.app.workspace.getLeaf("tab").openFile(arquivo);
		} else {
			new Notice(`Nota não encontrada: ${caminho}`);
		}
	}

	// -------------------------------------------------------------------------
	// Teclado (chamado pela view)
	// -------------------------------------------------------------------------

	/** Trata teclas de atalho. Devolve true quando consumiu a tecla. */
	tratarTecla(e: KeyboardEvent): boolean {
		// Digitando num campo de TEXTO, as teclas são do campo — não do mapa. Checkbox fica de
		// fora de propósito: ele guarda o foco depois de clicado, e incluí-lo aqui faria os
		// atalhos morrerem em silêncio até ela clicar em outro lugar.
		const alvo = e.target as HTMLElement;
		if (alvo.matches('input:not([type="checkbox"]), textarea') || alvo.isContentEditable) return false;

		const comando = e.ctrlKey || e.metaKey;

		// Ctrl+Z desfaz, Ctrl+Shift+Z (ou Ctrl+Y) refaz.
		if (comando && e.key.toLowerCase() === "z") {
			if (e.shiftKey) this.refazer();
			else this.desfazer();
			return true;
		}

		if (comando && e.key.toLowerCase() === "y") {
			this.refazer();
			return true;
		}

		// Ctrl+A seleciona tudo do nível: o atalho universal, e o caminho mais rápido para
		// mover um layout inteiro de lugar.
		if (e.key === "a" && (e.ctrlKey || e.metaKey)) {
			// Consome a tecla mesmo sem blocos: na tela em branco é onde ela mais aperta
			// Ctrl+A, e deixar passar faria o Obsidian selecionar o texto da interface.
			const blocos = this.nivelAtual().blocos;
			this.selecionados = new Set(blocos.map((b) => b.id));
			this.setaSelecionada = null;
			this.painel.mostrar(this.blocoUnicoSelecionado());
			this.aplicarClassesDeSelecao();
			return true;
		}

		// Só Delete, não Backspace: um bloco carrega a subárvore inteira, e a tecla mais fácil
		// de apertar sem querer não deve apagar nada — mesmo havendo Ctrl+Z.
		if (e.key === "Delete") {
			if (this.setaSelecionada) {
				this.excluirSetaSelecionada();
				return true;
			}
			const selecionados = this.blocosSelecionados();
			if (selecionados.length > 0) {
				this.pedirExclusao(selecionados);
				return true;
			}
		}

		if (e.key === "Escape") {
			if (this.selecionados.size > 0 || this.setaSelecionada) {
				this.limparSelecao();
				this.desenharPlano();
				return true;
			}
			if (this.caminho.length > 0) {
				this.voltar();
				return true;
			}
		}

		// Entrar num bloco é gesto de um só: com vários selecionados não há "o" bloco.
		const unico = this.blocoUnicoSelecionado();
		if (e.key === "Enter" && unico) {
			this.entrarNoBloco(unico.id);
			return true;
		}

		return false;
	}
}
