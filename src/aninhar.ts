import { Bloco, LARGURA_PADRAO } from "./tipos";

/**
 * Arrastar um bloco para DENTRO de outro — o gesto que transforma um bloco solto em filho.
 *
 * A regra é contenção total: o bloco arrastado precisa caber inteiro dentro do alvo. Assim
 * sobrepor blocos continua livre (um botão por cima de um banner é layout, não aninhamento),
 * e só entra quem foi claramente colocado dentro.
 */

/** Folga em pixels para o encaixe não exigir precisão absoluta nas bordas. */
const FOLGA = 2;

interface Retangulo {
	x: number;
	y: number;
	largura: number;
	altura: number;
}

export function contem(fora: Retangulo, dentro: Retangulo): boolean {
	return (
		dentro.x >= fora.x - FOLGA &&
		dentro.y >= fora.y - FOLGA &&
		dentro.x + dentro.largura <= fora.x + fora.largura + FOLGA &&
		dentro.y + dentro.altura <= fora.y + fora.altura + FOLGA
	);
}

function area(bloco: Bloco): number {
	return bloco.largura * bloco.altura;
}

/**
 * Acha o bloco que receberia `movel` se ele fosse solto agora, ou null.
 *
 * Entre vários candidatos (blocos aninhados no mesmo lugar) vence o MENOR: é o mais
 * específico, e é onde o gesto de "colocar dentro daquele ali" aponta.
 */
export function alvoDeAninhamento(movel: Bloco, irmaos: Bloco[]): Bloco | null {
	let melhor: Bloco | null = null;

	for (const candidato of irmaos) {
		if (candidato.id === movel.id) continue;
		if (!contem(candidato, movel)) continue;
		if (!melhor || area(candidato) < area(melhor)) melhor = candidato;
	}

	return melhor;
}

/**
 * Encontra um lugar vago para o bloco dentro do novo pai.
 *
 * Varre em faixas horizontais a partir do topo e devolve o primeiro ponto onde o bloco não
 * encosta em nenhum irmão. O plano do filho é infinito, então sempre há saída: se nada
 * couber entre os existentes, cai abaixo de todos.
 */
export function posicaoLivreDentro(bloco: Bloco, existentes: Bloco[]): { x: number; y: number } {
	const MARGEM = 24;
	const PASSO = 20;

	if (existentes.length === 0) return { x: MARGEM, y: MARGEM };

	const colide = (x: number, y: number): boolean =>
		existentes.some(
			(outro) =>
				x < outro.x + outro.largura + MARGEM &&
				x + bloco.largura + MARGEM > outro.x &&
				y < outro.y + outro.altura + MARGEM &&
				y + bloco.altura + MARGEM > outro.y
		);

	// Limita a varredura ao espaço já ocupado; além disso o lugar está livre por definição.
	const limiteX = Math.max(...existentes.map((b) => b.x + b.largura)) + LARGURA_PADRAO;
	const limiteY = Math.max(...existentes.map((b) => b.y + b.altura));

	for (let y = MARGEM; y <= limiteY + MARGEM; y += PASSO) {
		for (let x = MARGEM; x <= limiteX; x += PASSO) {
			if (!colide(x, y)) return { x, y };
		}
	}

	// Nada coube no meio: vai para baixo de tudo.
	return { x: MARGEM, y: limiteY + MARGEM * 2 };
}
