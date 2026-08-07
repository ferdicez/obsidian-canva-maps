import { Mapa, lerMapa } from "./tipos";

/**
 * Desfazer e refazer.
 *
 * Guarda o mapa inteiro serializado a cada passo, em vez de registrar operações inversas.
 * É mais memória, mas um `.cmap` é pequeno e a alternativa exigiria escrever e manter
 * correta a inversa de cada ação — mover, aninhar, excluir subárvore, religar setas. Um erro
 * ali corromperia o mapa em silêncio, que é o oposto do que "desfazer" promete.
 */

/** Passos guardados. Acima disso, os mais antigos são descartados. */
const LIMITE = 60;

/**
 * Ações do mesmo rótulo que se sucedem dentro desta janela viram um passo só.
 * É o que faz a digitação não voltar letra por letra.
 */
const JANELA_AGRUPAMENTO_MS = 600;

/**
 * Snapshot compacto. O arquivo em disco é indentado para o diff do git ficar legível, mas na
 * memória a indentação é peso morto: com dezenas de passos de um mapa grande, os espaços em
 * branco sozinhos custariam megabytes.
 */
function serializar(mapa: Mapa): string {
	return JSON.stringify(mapa);
}

export interface Passo {
	/** O mapa serializado ANTES da ação. */
	estado: string;
	/** Rótulo da ação, usado para agrupar ações repetidas (ex.: "texto:id-do-bloco"). */
	rotulo: string;
	momento: number;
}

export class Historico {
	private passados: Passo[] = [];
	private futuros: Passo[] = [];

	/**
	 * Registra o estado ANTERIOR a uma ação. Chamado antes de mexer no mapa.
	 *
	 * `rotulo` agrupa: duas chamadas seguidas com o mesmo rótulo dentro da janela de tempo
	 * não empilham um passo novo — a primeira já guardou o estado de onde se quer voltar.
	 * Passe um rótulo único para ações que devem ser um passo cada.
	 */
	registrar(mapa: Mapa, rotulo: string, agora: number): void {
		const ultimo = this.passados[this.passados.length - 1];
		if (ultimo && ultimo.rotulo === rotulo && agora - ultimo.momento < JANELA_AGRUPAMENTO_MS) {
			// Mesma ação continuando: só estende a janela, mantendo o estado inicial dela.
			ultimo.momento = agora;
			this.futuros = [];
			return;
		}

		this.passados.push({ estado: serializar(mapa), rotulo, momento: agora });
		if (this.passados.length > LIMITE) this.passados.shift();

		// Uma ação nova abandona o caminho refeito — é o comportamento de qualquer editor.
		this.futuros = [];
	}

	podeDesfazer(): boolean {
		return this.passados.length > 0;
	}

	podeRefazer(): boolean {
		return this.futuros.length > 0;
	}

	/** Devolve o mapa como estava antes da última ação, ou null se não há o que desfazer. */
	desfazer(mapaAtual: Mapa, agora: number): Mapa | null {
		const passo = this.passados.pop();
		if (!passo) return null;

		// `futuros` não precisa de limite próprio: só cresce consumindo `passados`, que é
		// limitado, então nunca passa de LIMITE.
		this.futuros.push({ estado: serializar(mapaAtual), rotulo: passo.rotulo, momento: agora });
		return lerMapa(passo.estado);
	}

	/** Refaz o passo desfeito mais recente, ou null se não há. */
	refazer(mapaAtual: Mapa, agora: number): Mapa | null {
		const passo = this.futuros.pop();
		if (!passo) return null;

		this.passados.push({ estado: serializar(mapaAtual), rotulo: passo.rotulo, momento: agora });
		return lerMapa(passo.estado);
	}

	/** Esquece tudo — usado quando a aba passa a mostrar outro arquivo. */
	limpar(): void {
		this.passados = [];
		this.futuros = [];
	}
}
