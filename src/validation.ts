import { z } from "zod";

const optionalNonEmptyString = z.preprocess(
	(value) => (value === "" ? undefined : value),
	z.string().optional(),
);

const optionalStringArray = z.preprocess(
	(value) => {
		if (value === undefined) {
			return [];
		}
		if (typeof value === "string") {
			return [value];
		}

		return value;
	},
	z.array(z.string().min(1)),
);

const parseSafeInteger = (
	value: string | undefined,
	flag: string,
	minimum: number,
): number | undefined => {
	if (!value) {
		return undefined;
	}

	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < minimum) {
		throw new Error(`${flag} must be an integer greater than or equal to ${minimum}.`);
	}

	return parsed;
};

export { optionalNonEmptyString, optionalStringArray, parseSafeInteger };
