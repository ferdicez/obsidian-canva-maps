import { Notice, Plugin, TFolder, normalizePath } from "obsidian";
import { EXTENSAO_CMAP, escreverMapa, mapaVazio } from "./tipos";
import { TIPO_VISTA_MAPA, VistaMapa } from "./vista-mapa";
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

		this.registerView(TIPO_VISTA_MAPA, (leaf) => new VistaMapa(leaf));

		// É isto que faz um arquivo .cmap abrir nesta view ao clicar nele na barra lateral.
		this.registerExtensions([EXTENSAO_CMAP], TIPO_VISTA_MAPA);

		// Ícone na barra lateral esquerda. Abre o mapa mais recente em vez de sempre criar um
		// novo — o gesto de "voltar para os meus mapas" é muito mais frequente que o de começar
		// do zero, e criar um arquivo a cada clique encheria o vault de mapas vazios.
		this.addRibbonIcon("layout-dashboard", "Canva Maps", () => this.abrirOuCriarMapa());

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
	private async criarMapa(pasta?: TFolder): Promise<void> {
		const destino = pasta ?? (await this.pastaPadrao());
		const caminho = await this.caminhoLivre(destino, "Novo mapa");

		try {
			const arquivo = await this.app.vault.create(caminho, escreverMapa(mapaVazio()));
			await this.app.workspace.getLeaf(true).openFile(arquivo);
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
