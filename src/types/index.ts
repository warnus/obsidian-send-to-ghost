export interface SettingsProp {
	url: string;
	adminToken: string;
	debug: boolean
}

export const DEFAULT_SETTINGS: SettingsProp = {
	url: "",
	adminToken: "",
	debug: false
};

export interface ContentProp {
	title: string;
	tags?: string[];
	featured?: boolean;
	status: string;
	excerpt?: string | undefined;
	feature_image?: string;
	updated_at?: string;
}

export interface DataProp {
	content: string;
}

export interface GhostPost {
	id: string;
	title: string;
	status: string;
	updated_at: string;
}
