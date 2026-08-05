import { App, Menu, Notice, TFile, setIcon } from "obsidian";
import {
	ALTURA_MINIMA,
	Bloco,
	LARGURA_MINIMA,
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
			bloco: Bloco;
			inicioX: number;
			inicioY: number;
			blocoX: number;
			blocoY: number;
			moveu: boolean;
	  }
	| {
			tipo: "redimensionar";
			bloco: Bloco;
			inicioX: number;
			inicioY: number;
			largura: number;
			altura: number;
	  }
	| { tipo: "seta"; de: Bloco; lado: Lado; x: number; y: number };

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

	/** Caminho de ids até o nível aberto. Vazio = raiz. */
	private caminho: string[] = [];
	private blocoSelecionado: string | null = null;
	private setaSelecionada: string | null = null;

	constructor(
		pai: HTMLElement,
		private app: App,
		private mapa: Mapa,
		private aoSalvar: () => void
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
			(bloco) => this.pedirExclusao(bloco)
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
	definirMapa(mapa: Mapa): void {
		this.mapa = mapa;
		this.arrasto = { tipo: "nenhum" };
		this.linhaProvisoria?.remove();
		this.linhaProvisoria = null;

		if (!nivelDoCaminho(this.mapa, this.caminho)) this.caminho = [];

		this.reancorarSelecao();
		this.desenhar();
	}

	/** Reaponta a seleção para os objetos equivalentes da árvore atual, ou limpa o que sumiu. */
	private reancorarSelecao(): void {
		const nivel = this.nivelAtual();

		const bloco = this.blocoSelecionado ? nivel.blocos.find((b) => b.id === this.blocoSelecionado) : null;
		this.blocoSelecionado = bloco?.id ?? null;
		this.painel.reapontar(bloco ?? null);

		if (this.setaSelecionada && !nivel.setas.some((s) => s.id === this.setaSelecionada)) {
			this.setaSelecionada = null;
		}
	}

	destruir(): void {
		this.raiz.remove();
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
		this.blocoSelecionado = null;
		this.setaSelecionada = null;
		this.painel.mostrar(null);
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

		const raiz = caminho.createEl("button", { cls: "cmap-trilha-item", text: "Mapa" });
		raiz.addEventListener("click", () => this.irParaNivel(0));

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
			this.plano.querySelectorAll(".cmap-bloco-alvo").forEach((el) => el.removeClass("cmap-bloco-alvo"));
		}

		// Remove só os cards; o SVG das setas é reaproveitado.
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
		if (this.blocoSelecionado === bloco.id) card.addClass("cmap-bloco-selecionado");

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
		// Só o botão principal inicia o pan; o direito é menu de contexto.
		if (e.button !== 0) return;
		if ((e.target as HTMLElement).closest(".cmap-bloco")) return;

		this.limparSelecao();
		this.desenharPlano();

		this.arrasto = {
			tipo: "plano",
			inicioX: e.clientX,
			inicioY: e.clientY,
			cameraX: this.camera.x,
			cameraY: this.camera.y,
		};
		this.area.addClass("cmap-area-arrastando");
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
		if (e.button !== 0) return;
		// As alças têm o próprio handler; sem isso o bloco andaria junto ao redimensionar.
		if ((e.target as HTMLElement).closest(".cmap-bloco-alca, .cmap-bloco-alca-seta")) return;
		if ((e.target as HTMLElement).closest("input")) return;

		e.stopPropagation();
		this.selecionarBloco(bloco);

		this.arrasto = {
			tipo: "bloco",
			bloco,
			inicioX: e.clientX,
			inicioY: e.clientY,
			blocoX: bloco.x,
			blocoY: bloco.y,
			moveu: false,
		};
	}

	private iniciarRedimensionamento(e: MouseEvent, bloco: Bloco): void {
		if (e.button !== 0) return;
		e.stopPropagation();
		e.preventDefault();

		this.arrasto = {
			tipo: "redimensionar",
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

				this.posicionarCard(bloco);
				this.redesenharSetas();
				break;
			}
			case "redimensionar": {
				const dx = (e.clientX - this.arrasto.inicioX) / this.camera.zoom;
				const dy = (e.clientY - this.arrasto.inicioY) / this.camera.zoom;
				const alvo = this.arrasto.bloco;
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
		const arrasto = this.arrasto;
		this.arrasto = { tipo: "nenhum" };
		this.area.removeClass("cmap-area-arrastando");
		this.limparGuias();

		if (arrasto.tipo === "bloco" && arrasto.moveu) {
			this.aoSalvar();
		} else if (arrasto.tipo === "redimensionar") {
			this.aoSalvar();
		} else if (arrasto.tipo === "seta") {
			this.finalizarSeta(arrasto.de, e);
		}
	};

	/** Os outros blocos do nível: com quem o bloco em movimento pode se alinhar. */
	private vizinhosDe(bloco: Bloco): Bloco[] {
		return this.nivelAtual().blocos.filter((b) => b.id !== bloco.id);
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

		nivel.setas.push({ id: novoId(), de: de.id, para: idAlvo, rotulo: "" });
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

	private selecionarBloco(bloco: Bloco): void {
		this.blocoSelecionado = bloco.id;
		this.setaSelecionada = null;
		this.painel.mostrar(bloco);

		this.plano.querySelectorAll(".cmap-bloco-selecionado").forEach((el) => el.removeClass("cmap-bloco-selecionado"));
		this.plano.querySelector(`.cmap-bloco[data-id="${bloco.id}"]`)?.addClass("cmap-bloco-selecionado");
		this.redesenharSetas();
	}

	private selecionarSeta(seta: Seta): void {
		this.setaSelecionada = seta.id;
		this.blocoSelecionado = null;
		this.painel.mostrar(null);
		this.plano.querySelectorAll(".cmap-bloco-selecionado").forEach((el) => el.removeClass("cmap-bloco-selecionado"));
		this.redesenharSetas();
	}

	private criarBloco(x: number, y: number): void {
		const bloco = novoBloco(Math.round(x), Math.round(y));
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
		this.criarBloco(centro.x - 140, centro.y - 90);
	}

	/**
	 * Exclui o bloco, confirmando antes quando há algo a perder. Um bloco com filhos leva
	 * a subárvore inteira junto e não existe desfazer no mapa — mas pedir confirmação para
	 * um card vazio recém-criado só atrapalharia.
	 */
	private pedirExclusao(bloco: Bloco): void {
		const descendentes = contarDescendentes(bloco);
		const temConteudo = descendentes > 0 || bloco.texto.trim() !== "" || bloco.checklist.length > 0;

		if (!temConteudo) {
			this.excluirBloco(bloco);
			return;
		}

		const nome = bloco.titulo || "Sem título";
		const detalhe =
			descendentes > 0
				? ` Isso apaga também ${descendentes} ${descendentes === 1 ? "bloco que está" : "blocos que estão"} dentro dele.`
				: "";

		new ModalConfirmar(
			this.app,
			"Excluir bloco",
			`Excluir "${nome}"?${detalhe} Não é possível desfazer.`,
			() => this.excluirBloco(bloco)
		).open();
	}

	private excluirBloco(bloco: Bloco): void {
		const nivel = this.nivelAtual();
		// Filtra por id, não por identidade: a referência pode ser de uma árvore anterior
		// (arquivo recarregado), e aí remover pelo objeto não acharia nada e falharia calado.
		const indice = nivel.blocos.findIndex((b) => b.id === bloco.id);
		if (indice === -1) return;

		nivel.blocos.splice(indice, 1);
		// Sem isso sobrariam setas apontando para um bloco que não existe mais.
		this.removerSetas((s) => s.de === bloco.id || s.para === bloco.id);

		this.painel.fecharSe(bloco.id);
		if (this.blocoSelecionado === bloco.id) this.blocoSelecionado = null;
		this.aoSalvar();
		this.desenhar();
	}

	private duplicarBloco(bloco: Bloco): void {
		const copia = this.clonar(bloco);
		copia.x += 24;
		copia.y += 24;
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

		const menu = new Menu();

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

		menu.addItem((item) => {
			item.setTitle("Cor").setIcon("palette");
			const submenu = (item as unknown as { setSubmenu: () => Menu }).setSubmenu();
			for (const cor of Object.keys(ROTULO_DA_COR) as (keyof typeof ROTULO_DA_COR)[]) {
				submenu.addItem((sub) =>
					sub
						.setTitle(ROTULO_DA_COR[cor])
						.setChecked(bloco.cor === cor)
						.onClick(() => {
							bloco.cor = cor;
							this.aoSalvar();
							this.desenharPlano();
						})
				);
			}
		});

		// Vincular nota mora só aqui, não no painel: ela pediu para tirar de lá por ser fácil
		// de acionar sem querer. No menu ela é uma escolha deliberada.
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
							bloco.nota = arquivo.path;
							this.aoSalvar();
							this.desenharPlano();
						}).open();
					})
			);
		}

		menu.addSeparator();

		menu.addItem((item) =>
			item
				.setTitle("Excluir")
				.setIcon("trash-2")
				.onClick(() => this.pedirExclusao(bloco))
		);

		menu.showAtMouseEvent(e);
	}

	private excluirSetaSelecionada(): void {
		if (!this.setaSelecionada) return;
		const id = this.setaSelecionada;
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
		// Digitando num campo, as teclas são do campo — não do mapa.
		const alvo = e.target as HTMLElement;
		if (alvo.matches("input, textarea") || alvo.isContentEditable) return false;

		// Só Delete, não Backspace: um bloco carrega a subárvore inteira e não há desfazer,
		// então a tecla mais fácil de apertar sem querer não pode apagar nada.
		if (e.key === "Delete") {
			if (this.setaSelecionada) {
				this.excluirSetaSelecionada();
				return true;
			}
			if (this.blocoSelecionado) {
				const bloco = this.nivelAtual().blocos.find((b) => b.id === this.blocoSelecionado);
				if (bloco) {
					this.pedirExclusao(bloco);
					return true;
				}
			}
		}

		if (e.key === "Escape") {
			if (this.blocoSelecionado || this.setaSelecionada) {
				this.limparSelecao();
				this.desenharPlano();
				return true;
			}
			if (this.caminho.length > 0) {
				this.voltar();
				return true;
			}
		}

		if (e.key === "Enter" && this.blocoSelecionado) {
			this.entrarNoBloco(this.blocoSelecionado);
			return true;
		}

		return false;
	}
}
