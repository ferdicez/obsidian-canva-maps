/**
 * Formato do arquivo .cmap — um arquivo por mapa, JSON no espírito do .canvas nativo,
 * com uma diferença central: cada bloco carrega seus próprios filhos e setas, que é o
 * aninhamento que o Canvas do Obsidian não tem.
 *
 * Regra de ouro da leitura: nunca confie no que veio do disco. O arquivo pode ter sido
 * editado à mão, salvo por uma versão futura do plugin ou truncado por uma sincronização.
 * Todo campo é validado em `normalizar*` e cai num padrão quando não bate.
 */

/** Versão do formato gravada no arquivo. Sobe quando a estrutura mudar de forma incompatível. */
export const VERSAO_FORMATO = 1;

/** Extensão registrada pelo plugin. */
export const EXTENSAO_CMAP = "cmap";

/**
 * Identificadores das views. Moram aqui, e não nos arquivos que as definem, porque as duas
 * views navegam uma para a outra — importar o tipo do módulo vizinho criaria ciclo.
 */
export const TIPO_VISTA_MAPA = "canva-maps-mapa";
export const TIPO_VISTA_GALERIA = "canva-maps-galeria";

/**
 * Cores disponíveis para um bloco. São nomes, não hex: assim o mapa acompanha o tema
 * claro/escuro do Obsidian em vez de ficar com cor fixa que some no fundo escuro.
 */
export const CORES = ["cinza", "vermelho", "laranja", "amarelo", "verde", "azul", "roxo", "rosa"] as const;
export type Cor = (typeof CORES)[number];
export const COR_PADRAO: Cor = "cinza";

/** Rótulo em português para exibir no menu de cor. */
export const ROTULO_DA_COR: Record<Cor, string> = {
	cinza: "Cinza",
	vermelho: "Vermelho",
	laranja: "Laranja",
	amarelo: "Amarelo",
	verde: "Verde",
	azul: "Azul",
	roxo: "Roxo",
	rosa: "Rosa",
};

/** Um item de checklist dentro de um bloco. */
export interface ItemChecklist {
	id: string;
	texto: string;
	feito: boolean;
}

/**
 * Um bloco do mapa. É recursivo: `filhos` são os blocos que aparecem quando você
 * entra neste bloco (duplo clique), e `setas` são as ligações entre esses filhos.
 */
export interface Bloco {
	id: string;
	titulo: string;
	/** Observações do bloco. Aparece no card e no topo da tela quando você entra nele. */
	texto: string;
	/** Posição e tamanho na tela do PAI (coordenadas do mapa, não da janela). */
	x: number;
	y: number;
	largura: number;
	altura: number;
	cor: Cor;
	/** Caminho de uma nota do vault que este bloco representa, ou null. */
	nota: string | null;
	checklist: ItemChecklist[];
	/** Blocos que existem DENTRO deste. É o aninhamento. */
	filhos: Bloco[];
	/** Setas entre os `filhos` deste bloco. */
	setas: Seta[];
}

/** Uma ligação entre dois blocos irmãos (mesmo nível). */
export interface Seta {
	id: string;
	de: string;
	para: string;
	rotulo: string;
}

/** O arquivo .cmap inteiro. A raiz se comporta como um bloco sem título. */
export interface Mapa {
	versao: number;
	/** Blocos do nível raiz. */
	blocos: Bloco[];
	/** Setas entre os blocos da raiz. */
	setas: Seta[];
}

export const LARGURA_PADRAO = 280;
export const ALTURA_PADRAO = 180;

/**
 * Mínimos baixos de propósito: os blocos representam elementos de uma tela, e um wireframe
 * precisa de formatos finos — uma barra lateral de 60px de largura, um cabeçalho de 40px de
 * altura. Um mínimo confortável para ler texto impediria justamente o que o plugin serve.
 * O card esconde o que não couber (ver styles.css) em vez de estourar.
 */
export const LARGURA_MINIMA = 32;
export const ALTURA_MINIMA = 28;

/** Gera um id curto e único o bastante para blocos e setas dentro de um arquivo. */
export function novoId(): string {
	return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export function mapaVazio(): Mapa {
	return { versao: VERSAO_FORMATO, blocos: [], setas: [] };
}

export function novoBloco(x: number, y: number, titulo = "Novo bloco"): Bloco {
	return {
		id: novoId(),
		titulo,
		texto: "",
		x,
		y,
		largura: LARGURA_PADRAO,
		altura: ALTURA_PADRAO,
		cor: COR_PADRAO,
		nota: null,
		checklist: [],
		filhos: [],
		setas: [],
	};
}

// ---------------------------------------------------------------------------
// Normalização: converte o que veio do disco (desconhecido) em dados confiáveis.
// ---------------------------------------------------------------------------

function ehObjeto(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function texto(v: unknown, padrao = ""): string {
	return typeof v === "string" ? v : padrao;
}

function numero(v: unknown, padrao: number): number {
	return typeof v === "number" && Number.isFinite(v) ? v : padrao;
}

function booleano(v: unknown, padrao = false): boolean {
	return typeof v === "boolean" ? v : padrao;
}

function cor(v: unknown): Cor {
	return typeof v === "string" && (CORES as readonly string[]).includes(v) ? (v as Cor) : COR_PADRAO;
}

function lista(v: unknown): unknown[] {
	return Array.isArray(v) ? v : [];
}

function normalizarChecklist(bruto: unknown): ItemChecklist[] {
	return lista(bruto)
		.filter(ehObjeto)
		.map((item) => ({
			id: texto(item.id) || novoId(),
			texto: texto(item.texto),
			feito: booleano(item.feito),
		}));
}

/**
 * Normaliza as setas de um nível, descartando as que apontam para blocos que não existem
 * mais ali (bloco apagado, arquivo editado à mão) — seta órfã viraria linha solta na tela.
 */
function normalizarSetas(bruto: unknown, idsValidos: Set<string>): Seta[] {
	const vistas = new Set<string>();
	const resultado: Seta[] = [];

	for (const item of lista(bruto)) {
		if (!ehObjeto(item)) continue;
		const de = texto(item.de);
		const para = texto(item.para);
		if (!idsValidos.has(de) || !idsValidos.has(para) || de === para) continue;

		// Uma seta só entre o mesmo par, no mesmo sentido.
		const chave = `${de}>${para}`;
		if (vistas.has(chave)) continue;
		vistas.add(chave);

		resultado.push({ id: texto(item.id) || novoId(), de, para, rotulo: texto(item.rotulo) });
	}

	return resultado;
}

/**
 * Normaliza um bloco e, recursivamente, seus filhos.
 *
 * `idsUsados` percorre a árvore inteira para garantir id único global no arquivo: dois blocos
 * com o mesmo id fariam a navegação entrar no bloco errado, e um mapa duplicado à mão é um
 * jeito fácil de isso acontecer.
 */
function normalizarBloco(bruto: Record<string, unknown>, idsUsados: Set<string>): Bloco {
	let id = texto(bruto.id);
	if (!id || idsUsados.has(id)) id = novoId();
	idsUsados.add(id);

	const filhos = normalizarBlocos(bruto.filhos, idsUsados);

	return {
		id,
		titulo: texto(bruto.titulo, "Sem título"),
		texto: texto(bruto.texto),
		x: numero(bruto.x, 0),
		y: numero(bruto.y, 0),
		largura: Math.max(LARGURA_MINIMA, numero(bruto.largura, LARGURA_PADRAO)),
		altura: Math.max(ALTURA_MINIMA, numero(bruto.altura, ALTURA_PADRAO)),
		cor: cor(bruto.cor),
		nota: typeof bruto.nota === "string" && bruto.nota ? bruto.nota : null,
		checklist: normalizarChecklist(bruto.checklist),
		filhos,
		setas: normalizarSetas(bruto.setas, new Set(filhos.map((f) => f.id))),
	};
}

function normalizarBlocos(bruto: unknown, idsUsados: Set<string>): Bloco[] {
	return lista(bruto)
		.filter(ehObjeto)
		.map((b) => normalizarBloco(b, idsUsados));
}

/** Converte o conteúdo cru do arquivo em um Mapa válido. Nunca lança: arquivo ruim vira mapa vazio. */
export function lerMapa(conteudo: string): Mapa {
	if (!conteudo.trim()) return mapaVazio();

	let bruto: unknown;
	try {
		bruto = JSON.parse(conteudo);
	} catch {
		return mapaVazio();
	}

	if (!ehObjeto(bruto)) return mapaVazio();

	const idsUsados = new Set<string>();
	const blocos = normalizarBlocos(bruto.blocos, idsUsados);

	return {
		versao: VERSAO_FORMATO,
		blocos,
		setas: normalizarSetas(bruto.setas, new Set(blocos.map((b) => b.id))),
	};
}

/** Serializa o mapa para gravar no arquivo. Indentado para o diff do git ficar legível. */
export function escreverMapa(mapa: Mapa): string {
	return JSON.stringify(mapa, null, 2);
}

// ---------------------------------------------------------------------------
// Navegação na árvore
// ---------------------------------------------------------------------------

/** Um nível aberto: a raiz (bloco null) ou um bloco em que se entrou. */
export interface Nivel {
	blocos: Bloco[];
	setas: Seta[];
}

/**
 * Devolve o nível correspondente a um caminho de ids (a "trilha" da navegação).
 * Caminho vazio = raiz. Se algum id do caminho não existir mais, devolve null —
 * quem chama decide voltar para a raiz.
 */
export function nivelDoCaminho(mapa: Mapa, caminho: string[]): Nivel | null {
	let atual: Nivel = { blocos: mapa.blocos, setas: mapa.setas };

	for (const id of caminho) {
		const bloco = atual.blocos.find((b) => b.id === id);
		if (!bloco) return null;
		atual = { blocos: bloco.filhos, setas: bloco.setas };
	}

	return atual;
}

/** Devolve os blocos do caminho, em ordem, para montar a trilha de navegação. */
export function blocosDoCaminho(mapa: Mapa, caminho: string[]): Bloco[] {
	const resultado: Bloco[] = [];
	let blocos = mapa.blocos;

	for (const id of caminho) {
		const bloco = blocos.find((b) => b.id === id);
		if (!bloco) break;
		resultado.push(bloco);
		blocos = bloco.filhos;
	}

	return resultado;
}

/** Conta blocos filhos em toda a subárvore — usado no rodapé do card ("3 blocos"). */
export function contarDescendentes(bloco: Bloco): number {
	return bloco.filhos.reduce((total, filho) => total + 1 + contarDescendentes(filho), 0);
}

/** Progresso do checklist de um bloco, ou null se não houver itens. */
export function progressoChecklist(bloco: Bloco): { feitos: number; total: number } | null {
	if (bloco.checklist.length === 0) return null;
	return { feitos: bloco.checklist.filter((i) => i.feito).length, total: bloco.checklist.length };
}
