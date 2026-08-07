import { ALTURA_MINIMA, Bloco, LARGURA_MINIMA } from "./tipos";

/**
 * Encaixe ("snap") ao arrastar e redimensionar, com as linhas-guia do Canvas nativo.
 *
 * A ideia: enquanto um bloco se move, comparamos suas bordas e seu centro com os dos
 * outros blocos do mesmo nível. Quando duas dessas referências ficam a menos de
 * TOLERANCIA pixels, o bloco "gruda" naquela coordenada e desenhamos a linha que mostra
 * com quem ele se alinhou.
 */

/** Distância (em px do mapa) dentro da qual o bloco gruda. */
const TOLERANCIA = 6;

/** Uma linha-guia a desenhar: vertical em `x`, ou horizontal em `y`. */
export interface Guia {
	orientacao: "vertical" | "horizontal";
	/** Coordenada fixa da linha (x se vertical, y se horizontal). */
	posicao: number;
	/** Extremos ao longo do outro eixo, para a linha cobrir só o trecho relevante. */
	de: number;
	ate: number;
}

export interface ResultadoEncaixe {
	x: number;
	y: number;
	guias: Guia[];
}

/** As três referências de um bloco num eixo: borda inicial, centro e borda final. */
function referencias(inicio: number, tamanho: number): number[] {
	return [inicio, inicio + tamanho / 2, inicio + tamanho];
}

interface Candidato {
	/** Quanto o bloco precisa andar para encaixar. */
	ajuste: number;
	/** Coordenada onde a linha-guia é desenhada. */
	posicao: number;
	/** Bloco com quem se alinhou, para dimensionar a linha. */
	alvo: Bloco;
	/** Distância original, usada só para comparar candidatos. */
	distancia: number;
}

/**
 * Procura o melhor encaixe num eixo: compara cada referência do bloco em movimento com
 * cada referência dos vizinhos e fica com a de menor distância. Empate exato é decidido
 * pela ordem dos blocos no nível — não vale gastar critério de desempate para o caso em
 * que as duas opções levam o card ao mesmo lugar.
 */
function melhorEncaixe(
	inicioMovel: number,
	tamanhoMovel: number,
	vizinhos: Bloco[],
	inicioDoVizinho: (b: Bloco) => number,
	tamanhoDoVizinho: (b: Bloco) => number
): Candidato | null {
	const minhas = referencias(inicioMovel, tamanhoMovel);
	let melhor: Candidato | null = null;

	for (const vizinho of vizinhos) {
		const delas = referencias(inicioDoVizinho(vizinho), tamanhoDoVizinho(vizinho));

		for (const minha of minhas) {
			for (const dela of delas) {
				const distancia = Math.abs(dela - minha);
				if (distancia > TOLERANCIA) continue;
				if (melhor && distancia >= melhor.distancia) continue;
				melhor = { ajuste: dela - minha, posicao: dela, alvo: vizinho, distancia };
			}
		}
	}

	return melhor;
}

/**
 * Calcula a posição encaixada de um bloco em movimento e as guias a exibir.
 * `x`/`y` são a posição livre (onde o ponteiro pediu); a devolvida é a corrigida.
 */
export function encaixarAoMover(
	x: number,
	y: number,
	largura: number,
	altura: number,
	vizinhos: Bloco[]
): ResultadoEncaixe {
	const horizontal = melhorEncaixe(
		x,
		largura,
		vizinhos,
		(b) => b.x,
		(b) => b.largura
	);
	const vertical = melhorEncaixe(
		y,
		altura,
		vizinhos,
		(b) => b.y,
		(b) => b.altura
	);

	const finalX = horizontal ? Math.round(x + horizontal.ajuste) : x;
	const finalY = vertical ? Math.round(y + vertical.ajuste) : y;

	const guias: Guia[] = [];

	if (horizontal) {
		// A linha vertical cobre do topo mais alto à base mais baixa entre os dois blocos,
		// para ficar claro quem está alinhado com quem.
		guias.push({
			orientacao: "vertical",
			posicao: horizontal.posicao,
			de: Math.min(finalY, horizontal.alvo.y),
			ate: Math.max(finalY + altura, horizontal.alvo.y + horizontal.alvo.altura),
		});
	}

	if (vertical) {
		guias.push({
			orientacao: "horizontal",
			posicao: vertical.posicao,
			de: Math.min(finalX, vertical.alvo.x),
			ate: Math.max(finalX + largura, vertical.alvo.x + vertical.alvo.largura),
		});
	}

	return { x: finalX, y: finalY, guias };
}

/**
 * Encaixe ao redimensionar: só as bordas direita e inferior se movem, então comparamos
 * apenas elas — grudar o centro aqui faria o card pular de tamanho sem motivo aparente.
 */
export function encaixarAoRedimensionar(
	bloco: Bloco,
	largura: number,
	altura: number,
	vizinhos: Bloco[]
): { largura: number; altura: number; guias: Guia[] } {
	const guias: Guia[] = [];
	let larguraFinal = largura;
	let alturaFinal = altura;

	const direita = bloco.x + largura;
	const baixo = bloco.y + altura;

	let melhorX: { posicao: number; alvo: Bloco; distancia: number } | null = null;
	let melhorY: { posicao: number; alvo: Bloco; distancia: number } | null = null;

	for (const vizinho of vizinhos) {
		for (const referencia of referencias(vizinho.x, vizinho.largura)) {
			const distancia = Math.abs(referencia - direita);
			if (distancia <= TOLERANCIA && (!melhorX || distancia < melhorX.distancia)) {
				melhorX = { posicao: referencia, alvo: vizinho, distancia };
			}
		}
		for (const referencia of referencias(vizinho.y, vizinho.altura)) {
			const distancia = Math.abs(referencia - baixo);
			if (distancia <= TOLERANCIA && (!melhorY || distancia < melhorY.distancia)) {
				melhorY = { posicao: referencia, alvo: vizinho, distancia };
			}
		}
	}

	// Rede de segurança: quem chama já limita ao mínimo antes de chegar aqui, mas o encaixe
	// puxa o tamanho para a referência do vizinho e poderia furar esse piso. Encaixe que
	// furaria é descartado — e a guia não aparece, porque o alinhamento não aconteceu.
	const encaixaX = melhorX !== null && melhorX.posicao - bloco.x >= LARGURA_MINIMA;
	const encaixaY = melhorY !== null && melhorY.posicao - bloco.y >= ALTURA_MINIMA;

	// Os dois tamanhos são resolvidos ANTES de montar as guias: uma guia usa o tamanho do
	// outro eixo para saber onde terminar, e com um eixo ainda desatualizado a linha pararia
	// antes da borda do próprio card — justamente a precisão que a guia existe para mostrar.
	if (encaixaX && melhorX) larguraFinal = Math.round(melhorX.posicao - bloco.x);
	if (encaixaY && melhorY) alturaFinal = Math.round(melhorY.posicao - bloco.y);

	if (encaixaX && melhorX) {
		guias.push({
			orientacao: "vertical",
			posicao: melhorX.posicao,
			de: Math.min(bloco.y, melhorX.alvo.y),
			ate: Math.max(bloco.y + alturaFinal, melhorX.alvo.y + melhorX.alvo.altura),
		});
	}

	if (encaixaY && melhorY) {
		guias.push({
			orientacao: "horizontal",
			posicao: melhorY.posicao,
			de: Math.min(bloco.x, melhorY.alvo.x),
			ate: Math.max(bloco.x + larguraFinal, melhorY.alvo.x + melhorY.alvo.largura),
		});
	}

	return { largura: larguraFinal, altura: alturaFinal, guias };
}
