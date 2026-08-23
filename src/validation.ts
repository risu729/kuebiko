import { z } from "zod";

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

const parseRegex = (value: string, flag: string): RegExp => {
	try {
		return new RegExp(value, "u");
	} catch (error) {
		throw new Error(`${flag} must be a valid JavaScript regular expression.`, { cause: error });
	}
};

const parseNonEmptyText = (value: string | undefined, flag: string): string | undefined => {
	if (value !== undefined && !value.trim()) {
		throw new Error(`${flag} must not be empty.`);
	}

	return value;
};

// A blank value used to be dropped as if the flag had never been passed at all.
// A wrapper script expanding an unset variable then ran with no filter or no body cap.
// It could also run against the default browser profile, with nothing saying so.
// This is a factory rather than one shared schema so no call site can forget the name.
const nonEmptyString = (
	flag: string,
): z.ZodPipe<z.ZodOptional<z.ZodString>, z.ZodTransform<string | undefined, string | undefined>> =>
	z.optional(z.string()).transform((value) => parseNonEmptyText(value, flag));

// Number() also accepts exponents, hex, and surrounding whitespace.
// A typo such as `--max-body-bytes 1e3` silently became a 1000 byte cap.
const decimalIntegerRegex = /^\d+$/u;

const parseSafeInteger = (
	value: string | undefined,
	flag: string,
	minimum: number,
): number | undefined => {
	if (!value) {
		return undefined;
	}

	const parsed = Number(value);
	if (!decimalIntegerRegex.test(value) || !Number.isSafeInteger(parsed) || parsed < minimum) {
		throw new Error(`${flag} must be an integer greater than or equal to ${minimum}.`);
	}

	return parsed;
};

export { nonEmptyString, optionalStringArray, parseNonEmptyText, parseRegex, parseSafeInteger };
