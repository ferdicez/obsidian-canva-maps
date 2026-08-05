import { Bloco, Seta } from "./tipos";

const NS_SVG = "http://www.w3.org/2000/svg";

/**
 * O elemento SVG é posicionado em -10000,-10000 com 20000x20000 (ver styles.css) para
 * alcançar coordenadas negativas do mapa. Este viewBox faz o sistema interno do SVG
 * coincidir com o dos cards, então as setas usam x/y do mapa direto.
 */
const DESLOCAMENTO_SVG = 10000;
const LADO_SVG = 20000;

/** Ajusta o viewBox do SVG. Idempotente — chamado a cada desenho. */
function ajustarViewBox(svg: SVGSVGElement): void {
	svg.setAttribute(
		"viewBox",
		`${-DESLOCAMENTO_SVG} ${-DESLOCAMENTO_SVG} ${LADO_SVG} ${LADO_SVG}`
	);
}

/** Lado de um bloco de onde a seta sai ou onde chega. */
export type Lado = "cima" | "baixo" | "esquerda" | "direita";

export interface Ponto {
	x: number;
	y: number;
}

/** Centro de um bloco, em coordenadas do mapa. */
function centro(bloco: Bloco): Ponto {
	return { x: bloco.x + bloco.largura / 2, y: bloco.y + bloco.altura / 2 };
}

/**
 * Escolhe de que lados a seta sai e chega, comparando a posição relativa dos blocos.
 * Se estão mais afastados na horizontal, liga lado a lado; senão, topo a base.
 * É o mesmo critério do Canvas nativo e evita seta atravessando o próprio card.
 */
function ladosEntre(de: Bloco, para: Bloco): { saida: Lado; chegada: Lado } {
	const c1 = centro(de);
	const c2 = centro(para);
	const dx = c2.x - c1.x;
	const dy = c2.y - c1.y;

	if (Math.abs(dx) >= Math.abs(dy)) {
		return dx >= 0 ? { saida: "direita", chegada: "esquerda" } : { saida: "esquerda", chegada: "direita" };
	}
	return dy >= 0 ? { saida: "baixo", chegada: "cima" } : { saida: "cima", chegada: "baixo" };
}

/** Ponto na borda do bloco, no lado indicado. */
export function pontoNoLado(bloco: Bloco, lado: Lado): Ponto {
	const c = centro(bloco);
	switch (lado) {
		case "cima":
			return { x: c.x, y: bloco.y };
		case "baixo":
			return { x: c.x, y: bloco.y + bloco.altura };
		case "esquerda":
			return { x: bloco.x, y: c.y };
		case "direita":
			return { x: bloco.x + bloco.largura, y: c.y };
	}
}

/** Vetor unitário apontando para fora do bloco, usado para curvar a linha. */
function paraFora(lado: Lado): Ponto {
	switch (lado) {
		case "cima":
			return { x: 0, y: -1 };
		case "baixo":
			return { x: 0, y: 1 };
		case "esquerda":
			return { x: -1, y: 0 };
		case "direita":
			return { x: 1, y: 0 };
	}
}

/**
 * Monta uma curva de Bézier entre dois blocos. Os pontos de controle saem
 * perpendiculares à borda, o que dá o mesmo ar do Canvas nativo em vez de uma reta seca.
 */
function caminhoCurva(de: Bloco, para: Bloco): { d: string; meio: Ponto; fim: Ponto; anguloFim: number } {
	const { saida, chegada } = ladosEntre(de, para);
	const p1 = pontoNoLado(de, saida);
	const p2 = pontoNoLado(para, chegada);

	const distancia = Math.hypot(p2.x - p1.x, p2.y - p1.y);
	// Curvatura proporcional à distância, com teto para não virar espiral em blocos distantes.
	const tensao = Math.min(120, Math.max(30, distancia * 0.35));

	const v1 = paraFora(saida);
	const v2 = paraFora(chegada);
	const c1 = { x: p1.x + v1.x * tensao, y: p1.y + v1.y * tensao };
	const c2 = { x: p2.x + v2.x * tensao, y: p2.y + v2.y * tensao };

	// Ponto médio da Bézier cúbica em t = 0.5, para ancorar o rótulo.
	const meio = {
		x: (p1.x + 3 * c1.x + 3 * c2.x + p2.x) / 8,
		y: (p1.y + 3 * c1.y + 3 * c2.y + p2.y) / 8,
	};

	// A ponta da seta aponta na direção de entrada, que é o oposto de "para fora" do destino.
	const anguloFim = Math.atan2(-v2.y, -v2.x);

	return {
		d: `M ${p1.x} ${p1.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${p2.x} ${p2.y}`,
		meio,
		fim: p2,
		anguloFim,
	};
}

export interface OpcoesSetas {
	/** Seta clicada — usado para selecioná-la e poder excluir. */
	aoClicar: (seta: Seta) => void;
	/** Id da seta atualmente selecionada, se houver. */
	selecionada: string | null;
}

/**
 * Desenha todas as setas de um nível dentro do `svg` informado.
 * O SVG cobre a mesma área do plano dos blocos, então usa as coordenadas do mapa direto.
 */
export function desenharSetas(svg: SVGSVGElement, blocos: Bloco[], setas: Seta[], opcoes: OpcoesSetas): void {
	ajustarViewBox(svg);
	while (svg.firstChild) svg.removeChild(svg.firstChild);

	const porId = new Map(blocos.map((b) => [b.id, b]));

	for (const seta of setas) {
		const de = porId.get(seta.de);
		const para = porId.get(seta.para);
		if (!de || !para) continue;

		const { d, meio, fim, anguloFim } = caminhoCurva(de, para);
		const grupo = document.createElementNS(NS_SVG, "g");
		grupo.classList.add("cmap-seta");
		if (opcoes.selecionada === seta.id) grupo.classList.add("cmap-seta-selecionada");

		// Traço largo e invisível por baixo: dá área de clique sem engrossar a seta.
		const alvo = document.createElementNS(NS_SVG, "path");
		alvo.setAttribute("d", d);
		alvo.classList.add("cmap-seta-alvo");
		grupo.appendChild(alvo);

		const linha = document.createElementNS(NS_SVG, "path");
		linha.setAttribute("d", d);
		linha.classList.add("cmap-seta-linha");
		grupo.appendChild(linha);

		grupo.appendChild(pontaDaSeta(fim, anguloFim));

		if (seta.rotulo) {
			const texto = document.createElementNS(NS_SVG, "text");
			texto.setAttribute("x", String(meio.x));
			texto.setAttribute("y", String(meio.y));
			texto.classList.add("cmap-seta-rotulo");
			texto.textContent = seta.rotulo;
			grupo.appendChild(texto);
		}

		grupo.addEventListener("mousedown", (e) => {
			e.stopPropagation();
			opcoes.aoClicar(seta);
		});

		svg.appendChild(grupo);
	}
}

/** Triângulo na ponta da seta, girado para acompanhar a direção de chegada. */
function pontaDaSeta(fim: Ponto, angulo: number): SVGPolygonElement {
	const tamanho = 9;
	const ponta = document.createElementNS(NS_SVG, "polygon");
	ponta.setAttribute("points", `0,0 ${-tamanho},${tamanho / 2.2} ${-tamanho},${-tamanho / 2.2}`);
	ponta.setAttribute(
		"transform",
		`translate(${fim.x} ${fim.y}) rotate(${(angulo * 180) / Math.PI})`
	);
	ponta.classList.add("cmap-seta-ponta");
	return ponta;
}
