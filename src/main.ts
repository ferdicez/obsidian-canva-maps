import { Notice, Plugin, TFolder, normalizePath } from "obsidian";
import { EXTENSAO_CMAP, escreverMapa, mapaVazio } from "./tipos";
import { TIPO_VISTA_MAPA, VistaMapa } from "./vista-mapa";
import { TIPO_VISTA_GALERIA, VistaGaleria } from "./vista-galeria";
import {
	CONFIGURACOES_PADRAO,
	ConfiguracoesCanvaMaps,
	carregarConfiguracoes,
	salvarConfiguracoes,
} from "./configuracoes";
import { PainelConfigCanvaMaps } from "./painel-config";

export default class CanvaMapsPlugin extends Plugin {
	configuracoes: ConfiguracoesCanvaMaps = { ...CONFIGURACOES_PADRAO };

	async onload() {
		this.configuracoes = await carregarConfiguracoes(this);
		this.addSettingTab(new PainelConfigCanvaMaps(this.app, this));

		this.registerView(TIPO_VISTA_MAPA, (leaf) => new VistaMapa(leaf, this));
		this.registerView(TIPO_VISTA_GALERIA, (leaf) => new VistaGaleria(leaf, this));

		// É isto que faz um arquivo .cmap abrir nesta view ao clicar nele na barra lateral.
		this.registerExtensions([EXTENSAO_CMAP], TIPO_VISTA_MAPA);

		// O ribbon abre a galeria, não um mapa: a página inicial do plugin é a visão do
		// conjunto, e é de lá que se entra num mapa ou se cria outro.
		this.addRibbonIcon("layout-dashboard", "Canva Maps", () => this.abrirGaleria());

		this.addCommand({
			id: "abrir-galeria",
			name: "Abrir mapas",
			callback: () => this.abrirGaleria(),
		});

		this.addCommand({
			id: "novo-mapa",
			name: "Criar novo mapa",
			callback: () => this.criarMapa(),
		});

		this.addCommand({
			id: "abrir-mapa",
			name: "Abrir mapa mais recente",
			callback: () => this.abrirOuCriarMapa(),
		});

		// Item de menu na pasta, para criar o mapa já no lugar certo.
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, arquivo) => {
				if (!(arquivo instanceof TFolder)) return;
				menu.addItem((item) =>
					item
						.setTitle("Novo mapa")
						.setIcon("layout-dashboard")
						.onClick(() => this.criarMapa(arquivo))
				);
			})
		);
	}

	async salvarConfiguracoes(): Promise<void> {
		await salvarConfiguracoes(this, this.configuracoes);
	}

	/**
	 * Abre a galeria de mapas. Se já houver uma aberta, vai para ela em vez de duplicar —
	 * a galeria é uma só, como a tela inicial de um app.
	 */
	async abrirGaleria(): Promise<void> {
		const existente = this.app.workspace.getLeavesOfType(TIPO_VISTA_GALERIA)[0];
		if (existente) {
			await this.app.workspace.revealLeaf(existente);
			return;
		}

		const leaf = this.app.workspace.getLeaf(true);
		await leaf.setViewState({ type: TIPO_VISTA_GALERIA, active: true });
		await this.app.workspace.revealLeaf(leaf);
	}

	/**
	 * Abre o mapa modificado por último; se o vault ainda não tem nenhum, cria o primeiro.
	 * Se o mapa já estiver aberto numa aba, vai para ela em vez de abrir de novo.
	 */
	private async abrirOuCriarMapa(): Promise<void> {
		const mapas = this.app.vault.getFiles().filter((f) => f.extension === EXTENSAO_CMAP);
		if (mapas.length === 0) {
			await this.criarMapa();
			return;
		}

		const recente = mapas.sort((a, b) => b.stat.mtime - a.stat.mtime)[0];

		const abaExistente = this.app.workspace
			.getLeavesOfType(TIPO_VISTA_MAPA)
			.find((leaf) => (leaf.view as VistaMapa).file?.path === recente.path);

		if (abaExistente) {
			await this.app.workspace.revealLeaf(abaExistente);
			return;
		}

		await this.app.workspace.getLeaf(true).openFile(recente);
	}

	/**
	 * Cria um .cmap vazio e abre.
	 *
	 * `pasta` só vem preenchida quando ela usou o menu de contexto de uma pasta — nesse caso o
	 * gesto diz onde criar, e a configuração não deve atropelar o que ela acabou de apontar.
	 */
	/**
	 * Cria um mapa e abre.
	 *
	 * `daGaleria` decide onde abrir: vindo da galeria, o mapa novo substitui a galeria na
	 * mesma aba (entrar num mapa novo é o mesmo gesto de entrar num existente). Vindo da
	 * paleta ou do menu de pasta, abre em aba nova — reaproveitar a aba da galeria a
	 * sequestraria de outro painel, possivelmente invisível, e pareceria que nada aconteceu.
	 */
	async criarMapa(pasta?: TFolder, daGaleria = false): Promise<void> {
		const destino = pasta ?? (await this.pastaPadrao());
		const caminho = await this.caminhoLivre(destino, "Novo mapa");

		try {
			const arquivo = await this.app.vault.create(caminho, escreverMapa(mapaVazio()));

			const galeriaAtiva = this.app.workspace.getActiveViewOfType(VistaGaleria)?.leaf;
			const alvo = daGaleria && galeriaAtiva ? galeriaAtiva : this.app.workspace.getLeaf(true);

			await alvo.openFile(arquivo);
			// Sem isto o mapa poderia nascer numa aba de fundo e ela não veria nada acontecer.
			await this.app.workspace.revealLeaf(alvo);
		} catch (erro) {
			new Notice(`Não foi possível criar o mapa: ${erro instanceof Error ? erro.message : erro}`);
		}
	}

	/**
	 * Pasta de destino: a configurada, se houver; senão a da nota aberta; senão a raiz.
	 * Se a pasta configurada tiver sido apagada ou renomeada, recria — melhor que jogar o
	 * mapa num lugar inesperado sem avisar.
	 */
	private async pastaPadrao(): Promise<TFolder> {
		const escolhida = this.configuracoes.pastaDosMapas.trim();

		if (escolhida && escolhida !== "/") {
			const caminho = normalizePath(escolhida);
			const existente = this.app.vault.getAbstractFileByPath(caminho);
			if (existente instanceof TFolder) return existente;

			try {
				return await this.app.vault.createFolder(caminho);
			} catch {
				new Notice(`A pasta "${caminho}" não existe e não pôde ser criada. Salvando na pasta da nota aberta.`);
			}
		} else if (escolhida === "/") {
			return this.app.vault.getRoot();
		}

		const arquivoAtivo = this.app.workspace.getActiveFile();
		if (arquivoAtivo?.parent) return arquivoAtivo.parent;
		return this.app.vault.getRoot();
	}

	/** Acha um nome livre: "Novo mapa.cmap", "Novo mapa 2.cmap", … */
	private async caminhoLivre(pasta: TFolder, base: string): Promise<string> {
		const prefixo = pasta.isRoot() ? "" : `${pasta.path}/`;

		for (let n = 1; n < 1000; n++) {
			const nome = n === 1 ? base : `${base} ${n}`;
			const caminho = normalizePath(`${prefixo}${nome}.${EXTENSAO_CMAP}`);
			if (!this.app.vault.getAbstractFileByPath(caminho)) return caminho;
		}

		// Fallback improvável, mas melhor que estourar: usa o timestamp.
		return normalizePath(`${prefixo}${base} ${Date.now()}.${EXTENSAO_CMAP}`);
	}
}
