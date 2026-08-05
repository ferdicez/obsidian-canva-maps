import { Plugin } from "obsidian";

export interface ConfiguracoesCanvaMaps {
	/**
	 * Pasta onde os mapas novos são criados. Vazio = mesma pasta do arquivo aberto
	 * (comportamento anterior à existência desta configuração).
	 */
	pastaDosMapas: string;
}

export const CONFIGURACOES_PADRAO: ConfiguracoesCanvaMaps = {
	pastaDosMapas: "",
};

/** Lê o data.json preservando o que já estava lá (campos futuros, versões antigas). */
export async function carregarConfiguracoes(plugin: Plugin): Promise<ConfiguracoesCanvaMaps> {
	const salvo = (await plugin.loadData()) as Partial<ConfiguracoesCanvaMaps> | null;
	return {
		...CONFIGURACOES_PADRAO,
		...(salvo ?? {}),
		// Um valor não-string no disco (edição à mão) viraria erro ao normalizar o caminho.
		pastaDosMapas: typeof salvo?.pastaDosMapas === "string" ? salvo.pastaDosMapas : "",
	};
}

export async function salvarConfiguracoes(plugin: Plugin, config: ConfiguracoesCanvaMaps): Promise<void> {
	await plugin.saveData(config);
}
