type WaitState = {
	deadline: number;
	lastError?: unknown;
};

const waitFor = async <T>(
	description: string,
	read: () => Promise<T | undefined>,
	state: WaitState = { deadline: Date.now() + 15_000 },
): Promise<T> => {
	if (Date.now() >= state.deadline) {
		throw new Error(`Timed out waiting for ${description}`, { cause: state.lastError });
	}

	try {
		const result = await read();
		if (result !== undefined) {
			return result;
		}
	} catch (error) {
		await Bun.sleep(250);
		return await waitFor(description, read, { ...state, lastError: error });
	}

	await Bun.sleep(250);
	return await waitFor(description, read, state);
};

export default waitFor;
