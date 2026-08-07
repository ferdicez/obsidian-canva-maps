import { ItemView, Menu, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type CanvaMapsPlugin from "./main";
import { EXTENSAO_CMAP, TIPO_VISTA_GALERIA, contarDescendentes, lerMapa } from "./tipos";

export { TIPO_VISTA_GALERIA };

/** Como a lista é ordenada. Estado de instância: é navegação, não configuração. */
type Ordem = "recentes" | "alfabetica";

interface ItemGaleria {
	arquivo: TFile;
	/** Total de blocos em todos os níveis, ou null enquanto o arquivo não foi lido. */
	blocos: number | null;
}

/**
 * Página inicial do plugin: a grade de todos os mapas do vault.
 *
 * O ícone do ribbon abre esta view, e é daqui que se entra num mapa ou se cria outro —
 * o mapa em si nunca é o primeiro contato.
 */
export class VistaGaleria extends ItemView {
	/** Tela estática, não um arquivo: não entra no histórico de navegação do Obsidian. */
	navigation = false;

	private itens: ItemGaleria[] = [];
	private busca = "";
	private ordem: Ordem = "recentes";
	private agruparPorPasta = false;
	/** Guarda o corpo separado do cabeçalho: filtrar não deve recriar o campo de busca. */
	private corpoEl: HTMLElement | null = null;
	/** Marca da carga mais recente, para descartar respostas que chegam fora de ordem. */
	private geracao = 0;
	private recargaAgendada = 0;

	constructor(leaf: WorkspaceLeaf, private plugin: CanvaMapsPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return TIPO_VISTA_GALERIA;
	}

	getDisplayText(): string {
		return "Mapas";
	}

	getIcon(): string {
		return "layout-dashboard";
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass("cmap-galeria");
		await this.carregar();
		this.montar();

		// A grade reflete o vault: criar, apagar ou renomear um .cmap muda o que se vê aqui.
		this.registerEvent(this.app.vault.on("create", (a) => this.seAfetaGaleria(a.path) && this.agendarRecarga()));
		this.registerEvent(this.app.vault.on("delete", (a) => this.seAfetaGaleria(a.path) && this.agendarRecarga()));
		this.registerEvent(this.app.vault.on("modify", (a) => this.seAfetaGaleria(a.path) && this.agendarRecarga()));

		// rename recebe o caminho NOVO e o antigo. Testar só o novo perderia o caso de um .cmap
		// virar .md (o card ficaria na grade apontando para um arquivo que não existe mais), e
		// renomear uma PASTA não casaria com nenhum dos dois — daí o `true` para pasta.
		this.registerEvent(
			this.app.vault.on("rename", (arquivo, caminhoAntigo) => {
				if (this.seAfetaGaleria(arquivo.path) || this.seAfetaGaleria(caminhoAntigo)) {
					this.agendarRecarga();
				}
			})
		);
	}

	async onClose(): Promise<void> {
		window.clearTimeout(this.recargaAgendada);
		this.contentEl.empty();
		this.corpoEl = null;
	}

	/**
	 * Um caminho interessa à galeria se for um mapa ou uma pasta — renomear uma pasta muda
	 * o caminho dos mapas dentro dela e os títulos do agrupamento.
	 */
	private seAfetaGaleria(caminho: string): boolean {
		return caminho.endsWith(`.${EXTENSAO_CMAP}`) || !caminho.includes(".");
	}

	/**
	 * Agrupa rajadas de eventos numa recarga só.
	 *
	 * O mapa aberto salva a cada 2s enquanto ela edita, e cada save dispara `modify`. Sem
	 * isto, a galeria releria todos os mapas do vault a cada dois segundos de trabalho dela
	 * — e com a ordem "recentes" os cards ainda dançariam de lugar no meio da edição.
	 */
	private agendarRecarga(): void {
		window.clearTimeout(this.recargaAgendada);
		this.recargaAgendada = window.setTimeout(() => this.recarregar(), 400);
	}

	private async recarregar(): Promise<void> {
		await this.carregar();
		this.desenharCorpo();
	}

	/** Lê os mapas do vault e conta os blocos de cada um. */
	private async carregar(): Promise<void> {
		// Duas cargas podem correr juntas (evento durante o await) e terminar fora de ordem:
		// sem esta marca, a mais antiga sobrescreveria a mais nova e um mapa apagado
		// reapareceria na grade.
		const geracao = ++this.geracao;
		const arquivos = this.app.vault.getFiles().filter((f) => f.extension === EXTENSAO_CMAP);

		const itens = await Promise.all(
			arquivos.map(async (arquivo) => {
				try {
					// cachedRead: a contagem é informativa, não vale forçar leitura do disco.
					const conteudo = await this.app.vault.cachedRead(arquivo);
					const mapa = lerMapa(conteudo);
					const total = mapa.blocos.reduce((soma, b) => soma + 1 + contarDescendentes(b), 0);
					return { arquivo, blocos: total };
				} catch {
					// Arquivo ilegível não some da galeria: ela é como ela chega até ele.
					return { arquivo, blocos: null };
				}
			})
		);

		if (geracao !== this.geracao) return;
		this.itens = itens;
	}

	// -------------------------------------------------------------------------
	// Montagem
	// -------------------------------------------------------------------------

	private montar(): void {
		this.contentEl.empty();
		this.montarCabecalho();
		this.corpoEl = this.contentEl.createDiv({ cls: "cmap-galeria-corpo" });
		this.desenharCorpo();
	}

	private montarCabecalho(): void {
		const cabecalho = this.contentEl.createDiv({ cls: "cmap-galeria-cabecalho" });

		const linhaTitulo = cabecalho.createDiv({ cls: "cmap-galeria-linha-titulo" });
		linhaTitulo.createDiv({ cls: "cmap-galeria-titulo", text: "Mapas" });

		const novo = linhaTitulo.createEl("button", { cls: "cmap-galeria-novo" });
		setIcon(novo.createSpan({ cls: "cmap-galeria-novo-icone" }), "plus");
		novo.createSpan({ text: "Novo mapa" });
		novo.addEventListener("click", () => this.plugin.criarMapa(undefined, true));

		const ferramentas = cabecalho.createDiv({ cls: "cmap-galeria-ferramentas" });

		const busca = ferramentas.createEl("input", {
			cls: "cmap-galeria-busca",
			attr: { type: "search", placeholder: "Buscar mapa…" },
		});
		busca.value = this.busca;
		busca.addEventListener("input", () => {
			this.busca = busca.value;
			// Só o corpo é redesenhado: recriar o campo aqui perderia o foco a cada tecla.
			this.desenharCorpo();
		});

		const ordenar = ferramentas.createEl("button", {
			cls: "cmap-galeria-ferramenta",
			attr: { "aria-label": "Ordenar" },
		});
		this.rotularOrdenar(ordenar);
		ordenar.addEventListener("click", (e) => this.abrirMenuOrdem(e, ordenar));

		const agrupar = ferramentas.createEl("button", {
			cls: "cmap-galeria-ferramenta",
			attr: { "aria-label": "Agrupar por pasta" },
		});
		setIcon(agrupar.createSpan(), "folder-tree");
		agrupar.toggleClass("is-ativa", this.agruparPorPasta);
		agrupar.addEventListener("click", () => {
			this.agruparPorPasta = !this.agruparPorPasta;
			agrupar.toggleClass("is-ativa", this.agruparPorPasta);
			this.desenharCorpo();
		});
	}

	private rotularOrdenar(botao: HTMLElement): void {
		botao.empty();
		setIcon(botao.createSpan(), this.ordem === "recentes" ? "clock" : "arrow-down-a-z");
		botao.createSpan({ text: this.ordem === "recentes" ? "Recentes" : "A–Z" });
	}

	private abrirMenuOrdem(e: MouseEvent, botao: HTMLElement): void {
		const menu = new Menu();

		const opcoes: { valor: Ordem; titulo: string; icone: string }[] = [
			{ valor: "recentes", titulo: "Mais recentes primeiro", icone: "clock" },
			{ valor: "alfabetica", titulo: "Ordem alfabética", icone: "arrow-down-a-z" },
		];

		for (const opcao of opcoes) {
			menu.addItem((item) =>
				item
					.setTitle(opcao.titulo)
					.setIcon(opcao.icone)
					.setChecked(this.ordem === opcao.valor)
					.onClick(() => {
						this.ordem = opcao.valor;
						this.rotularOrdenar(botao);
						this.desenharCorpo();
					})
			);
		}

		menu.showAtMouseEvent(e);
	}

	// -------------------------------------------------------------------------
	// Corpo: a grade
	// -------------------------------------------------------------------------

	private desenharCorpo(): void {
		if (!this.corpoEl) return;

		// A grade é reconstruída inteira; sem guardar a rolagem, a galeria saltaria para o
		// topo a cada save do mapa que ela estivesse editando no painel ao lado.
		const rolagem = this.contentEl.scrollTop;
		this.corpoEl.empty();

		const visiveis = this.filtrarEOrdenar();

		if (visiveis.length === 0) {
			this.desenharVazio();
		} else if (this.agruparPorPasta) {
			for (const [pasta, itens] of this.agrupar(visiveis)) {
				this.corpoEl.createDiv({ cls: "cmap-galeria-grupo", text: pasta });
				this.desenharGrade(itens);
			}
		} else {
			this.desenharGrade(visiveis);
		}

		this.contentEl.scrollTop = rolagem;
	}

	private filtrarEOrdenar(): ItemGaleria[] {
		const termo = this.busca.trim().toLowerCase();
		const filtrados = termo
			? this.itens.filter((i) => i.arquivo.basename.toLowerCase().includes(termo))
			: [...this.itens];

		filtrados.sort((a, b) =>
			this.ordem === "alfabetica"
				? a.arquivo.basename.localeCompare(b.arquivo.basename, "pt-BR")
				: b.arquivo.stat.mtime - a.arquivo.stat.mtime
		);

		return filtrados;
	}

	/** Agrupa por pasta, mantendo a ordem já definida dentro de cada grupo. */
	private agrupar(itens: ItemGaleria[]): Map<string, ItemGaleria[]> {
		const grupos = new Map<string, ItemGaleria[]>();

		for (const item of itens) {
			const pasta = item.arquivo.parent?.path ?? "";
			const nome = !pasta || pasta === "/" ? "Raiz do vault" : pasta;
			const lista = grupos.get(nome);
			if (lista) lista.push(item);
			else grupos.set(nome, [item]);
		}

		return grupos;
	}

	private desenharGrade(itens: ItemGaleria[]): void {
		if (!this.corpoEl) return;
		const grade = this.corpoEl.createDiv({ cls: "cmap-galeria-grade" });
		for (const item of itens) this.desenharCard(grade, item);
	}

	private desenharCard(grade: HTMLElement, item: ItemGaleria): void {
		const card = grade.createDiv({ cls: "cmap-galeria-card" });
		card.setAttribute("role", "button");
		card.tabIndex = 0;

		const icone = card.createDiv({ cls: "cmap-galeria-card-icone" });
		setIcon(icone, "layout-dashboard");

		card.createDiv({ cls: "cmap-galeria-card-nome", text: item.arquivo.basename });
		card.createDiv({ cls: "cmap-galeria-card-info", text: this.descrever(item) });

		card.addEventListener("click", () => this.abrir(item.arquivo));
		card.addEventListener("keydown", (e) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				this.abrir(item.arquivo);
			}
		});
		card.addEventListener("contextmenu", (e) => this.abrirMenuDoCard(e, item.arquivo));
	}

	/** "12 blocos · ontem" — o que ajuda a reconhecer o mapa sem abri-lo. */
	private descrever(item: ItemGaleria): string {
		const partes: string[] = [];

		if (item.blocos === null) partes.push("não foi possível ler");
		else if (item.blocos === 0) partes.push("vazio");
		else partes.push(`${item.blocos} ${item.blocos === 1 ? "bloco" : "blocos"}`);

		partes.push(this.quandoFoi(item.arquivo.stat.mtime));
		return partes.join(" · ");
	}

	/** Data relativa em português, com o mesmo vocabulário do resto do Obsidian. */
	private quandoFoi(mtime: number): string {
		const dia = 24 * 60 * 60 * 1000;
		const hoje = new Date();
		const quando = new Date(mtime);

		// Compara datas do calendário, não intervalos: 23h atrás pode ser "ontem".
		const inicioDeHoje = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate()).getTime();
		const inicioDoDia = new Date(quando.getFullYear(), quando.getMonth(), quando.getDate()).getTime();
		const diasAtras = Math.round((inicioDeHoje - inicioDoDia) / dia);

		if (diasAtras <= 0) return "hoje";
		if (diasAtras === 1) return "ontem";
		if (diasAtras < 7) return `há ${diasAtras} dias`;
		return quando.toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" });
	}

	private desenharVazio(): void {
		if (!this.corpoEl) return;
		const vazio = this.corpoEl.createDiv({ cls: "cmap-galeria-vazio" });

		if (this.busca.trim()) {
			vazio.createDiv({ cls: "cmap-galeria-vazio-titulo", text: "Nenhum mapa com esse nome" });
			return;
		}

		vazio.createDiv({ cls: "cmap-galeria-vazio-titulo", text: "Nenhum mapa ainda" });
		vazio.createDiv({
			cls: "cmap-galeria-vazio-texto",
			text: "Um mapa é uma tela em branco onde você monta blocos para estruturar sites e sistemas.",
		});

		const criar = vazio.createEl("button", { cls: "cmap-galeria-novo", text: "Criar o primeiro mapa" });
		criar.addEventListener("click", () => this.plugin.criarMapa(undefined, true));
	}

	private async abrir(arquivo: TFile): Promise<void> {
		// Abre na mesma aba: a galeria é ponto de partida, não algo para deixar aberto atrás.
		await this.leaf.openFile(arquivo);
	}

	private abrirMenuDoCard(e: MouseEvent, arquivo: TFile): void {
		e.preventDefault();
		const menu = new Menu();

		menu.addItem((item) =>
			item
				.setTitle("Abrir")
				.setIcon("layout-dashboard")
				.onClick(() => this.abrir(arquivo))
		);

		menu.addItem((item) =>
			item
				.setTitle("Abrir em nova aba")
				.setIcon("plus")
				.onClick(() => this.app.workspace.getLeaf(true).openFile(arquivo))
		);

		// Entrega o resto (renomear, mover, excluir) ao menu nativo do arquivo, que já sabe
		// fazer tudo isso com as confirmações e integrações do Obsidian.
		menu.addSeparator();
		this.app.workspace.trigger("file-menu", menu, arquivo, "canva-maps-galeria");

		menu.showAtMouseEvent(e);
	}
}
