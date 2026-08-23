// Deadlines shared by the CDP shutdown paths and the browser process handling.
//
// A pending `Bun.sleep` would keep the process alive past the work it bounded, so a
// Run that had finished its teardown still sat idle until the longest abandoned sleep
// Expired. Every deadline here therefore runs on a timer, cleared as soon as the race
// Is decided.
const resolvesWithin = async <Value>(
	work: Promise<Value>,
	timeout: number,
	fallback: Value,
): Promise<Value> => {
	const { promise, resolve } = Promise.withResolvers<Value>();
	const timer = setTimeout(() => {
		resolve(fallback);
	}, timeout);
	try {
		return await Promise.race([work, promise]);
	} finally {
		clearTimeout(timer);
	}
};

const finished = async (work: Promise<void>): Promise<boolean> => {
	await work;
	return true;
};

// The same bound for work that only has to finish rather than answer with a value.
// A timeout answers false; the abandoned work is left to settle unused.
const finishesWithin = async (work: Promise<void>, timeout: number): Promise<boolean> =>
	await resolvesWithin(finished(work), timeout, false);

const settled = async (work: Promise<unknown>): Promise<boolean> => {
	try {
		await work;
	} catch {
		// Rejection also means the operation has settled.
	}

	return true;
};

// The same bound again for work whose failure is already reported somewhere else.
// Only the deadline answers false, so a rejection never escapes the bound.
const settlesWithin = async (work: Promise<unknown>, timeout: number): Promise<boolean> =>
	await resolvesWithin(settled(work), timeout, false);

export { finishesWithin, resolvesWithin, settlesWithin };
