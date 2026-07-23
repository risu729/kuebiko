import CDP from "chrome-remote-interface";

type PageContext = {
	cdpEndpoint: string;
	loggerStdout: {
		waitForNext: (text: string) => Promise<void>;
	};
};

const connectCdp = CDP;
const createCdpTarget = CDP.New;

const cdpConnectionOptions = (cdpEndpoint: string): { host: string; port: number } => {
	const endpoint = new URL(cdpEndpoint);
	if (!endpoint.port) {
		throw new Error(`CDP endpoint does not include a port: ${cdpEndpoint}`);
	}

	return { host: endpoint.hostname, port: Number(endpoint.port) };
};

const navigatePage = async (
	cdpEndpoint: string,
	target: CDP.Target,
	url: string,
): Promise<void> => {
	const client = await connectCdp({ ...cdpConnectionOptions(cdpEndpoint), target });
	try {
		await client.Page.navigate({ url });
	} finally {
		await client.close();
	}
};

const openNewPage = async (context: PageContext, url: string): Promise<void> => {
	const attached = context.loggerStdout.waitForNext("attached target=page session=");
	const target = await createCdpTarget({
		...cdpConnectionOptions(context.cdpEndpoint),
		url: "about:blank",
	});
	await attached;
	await navigatePage(context.cdpEndpoint, target, url);
};

export default openNewPage;
