import {
	CookieParseOptions,
	CookieSerializeOptions,
	Session,
	SessionStorage,
	isSession,
} from "@remix-run/server-runtime";
import { z } from "zod";

export interface TypedSession<Schema extends z.ZodTypeAny> {
	/**
	 * Marks a session as a typed session.
	 */
	readonly isTyped: boolean;

	/**
	 * A unique identifier for this session.
	 *
	 * Note: This will be the empty string for newly created sessions and
	 * sessions that are not backed by a database (i.e. cookie-based sessions).
	 */
	readonly id: string;
	/**
	 * The raw data contained in this session.
	 *
	 * This is useful mostly for SessionStorage internally to access the raw
	 * session data to persist.
	 */
	readonly data: z.infer<Schema>;
	/**
	 * Returns `true` if the session has a value for the given `name`, `false`
	 * otherwise.
	 */
	has<Key extends keyof z.infer<Schema>>(name: Key): boolean;
	/**
	 * Returns the value for the given `name` in this session.
	 */
	get<Key extends keyof z.infer<Schema>>(key: Key): z.infer<Schema>[Key] | null;
	/**
	 * Sets a value in the session for the given `name`.
	 */
	set<Key extends keyof z.infer<Schema>>(
		name: Key,
		value: z.infer<Schema>[Key],
	): void;
	/**
	 * Sets a value in the session that is only valid until the next `get()`.
	 * This can be useful for temporary values, like error messages.
	 */
	flash<Key extends keyof z.infer<Schema>>(
		name: Key,
		value: z.infer<Schema>[Key],
	): void;
	/**
	 * Removes a value from the session.
	 */
	unset<Key extends keyof z.infer<Schema>>(name: Key): void;
}

export interface TypedSessionStorage<Schema extends z.ZodTypeAny> {
	getSession(
		cookieHeader?: string | null | undefined,
		options?: CookieParseOptions | undefined,
	): Promise<TypedSession<Schema>>;

	commitSession(
		session: TypedSession<Schema>,
		options?: CookieSerializeOptions | undefined,
	): Promise<string>;

	destroySession(
		session: TypedSession<Schema>,
		options?: CookieSerializeOptions | undefined,
	): Promise<string>;
}

export function createTypedSessionStorage<Schema extends z.AnyZodObject>({
	sessionStorage,
	schema,
}: {
	sessionStorage: SessionStorage;
	schema: Schema;
}): TypedSessionStorage<Schema> {
	return {
		async getSession(cookieHeader, options?) {
			let session = await sessionStorage.getSession(cookieHeader, options);
			return await createTypedSession({ session, schema });
		},
		async commitSession(session, options?) {
			// check if session.data is valid
			await schema.parseAsync(session.data);
			return await sessionStorage.commitSession(session as Session, options);
		},
		async destroySession(session) {
			// check if session.data is valid
			await schema.parseAsync(session.data);
			return await sessionStorage.destroySession(session as Session);
		},
	};
}

async function createTypedSession<Schema extends z.AnyZodObject>({
	session,
	schema,
}: {
	session: Session;
	schema: Schema;
}): Promise<TypedSession<Schema>> {
	schema = enableTypeCoercion(schema) as Schema;
	// get a raw shape version of the schema but converting all the keys to their
	// flash versions.
	let flashSchema: z.ZodRawShape = {};
	for (let key in schema.shape) {
		flashSchema[flash(key)] = schema.shape[key].optional();
	}

	// parse session.data to add default values and remove invalid ones
	// we use strict mode here so we can throw an error if the session data
	// contains any invalid key, which is a sign that the session data is
	// corrupted.
	let data = await schema.extend(flashSchema).strict().parseAsync(session.data);

	return {
		get isTyped() {
			return true;
		},
		get id() {
			return session.id;
		},
		get data() {
			return data;
		},
		has(name) {
			let key = String(safeKey(schema, name));
			return key in data || flash(key) in data;
		},
		get(name) {
			let key = String(safeKey(schema, name));
			if (key in data) return data[key];
			let flashKey = flash(key);
			if (flashKey in data) {
				let value = data[flashKey];
				delete data[flashKey];
				return value;
			}
			return;
		},
		set(name, value) {
			let key = String(safeKey(schema, name));
			data[key] = value;
		},
		flash(name, value) {
			let key = String(safeKey(schema, name));
			let flashKey = flash(key);
			data[flashKey] = value;
		},
		unset(name) {
			let key = String(safeKey(schema, name));
			delete data[key];
		},
	};
}

/**
 * ReReturns true if an object is a Remix Utils typed session.
 *
 * @see https://github.com/sergiodxa/remix-utils#typed-session
 */
export function isTypedSession<Schema extends z.AnyZodObject>(
	value: unknown,
): value is TypedSession<Schema> {
	return (
		isSession(value) &&
		(value as unknown as { isTyped: boolean }).isTyped === true
	);
}

function flash<Key extends string>(name: Key): `__flash_${Key}__` {
	return `__flash_${name}__`;
}

// checks that the key is a valid key of the schema
function safeKey<Schema extends z.AnyZodObject>(
	schema: Schema,
	key: keyof z.infer<Schema>,
) {
	return schema.keyof().parse(key);
}

/**
 * Helpers for coercing string value
 * Modify the value only if it's a string, otherwise return the value as-is
 */
export function coerceString(
	value: unknown,
	transform?: (text: string) => unknown,
) {
	if (typeof value !== 'string') {
		return value
	}

	if (value === '') {
		return undefined
	}

	if (typeof transform !== 'function') {
		return value
	}

	return transform(value)
}

/**
 * Helpers for coercing file
 * Modify the value only if it's a file, otherwise return the value as-is
 */
export function coerceFile(file: unknown) {
	if (
		typeof File !== 'undefined' &&
		file instanceof File &&
		file.name === '' &&
		file.size === 0
	) {
		return undefined
	}

	return file
}

/**
 * A file schema is usually defined as `z.instanceof(File)`
 * which is implemented based on ZodAny with `superRefine`
 * Check the `instanceOfType` function on zod for more info
 */
export function isFileSchema(schema: z.ZodEffects<any, any, any>): boolean {
	if (typeof File === 'undefined') {
		return false
	}

	return (
		schema._def.effect.type === 'refinement' &&
		schema.innerType()._def.typeName === 'ZodAny' &&
		schema.safeParse(new File([], '')).success &&
		!schema.safeParse('').success
	)
}

/**
 * @deprecated Conform coerce empty strings to undefined by default
 */
export function ifNonEmptyString(fn: (text: string) => unknown) {
	return (value: unknown) => coerceString(value, fn)
}

/**
 * Reconstruct the provided schema with additional preprocessing steps
 * This coerce empty values to undefined and transform strings to the correct type
 */
export function enableTypeCoercion<Schema extends z.ZodTypeAny>(
	type: Schema,
	cache = new Map<z.ZodTypeAny, z.ZodTypeAny>(),
): z.ZodType<z.output<Schema>> {
	const result = cache.get(type)

	// Return the cached schema if it's already processed
	// This is to prevent infinite recursion caused by z.lazy()
	if (result) {
		return result
	}

	let schema: z.ZodTypeAny = type
	let def = (type as z.ZodFirstPartySchemaTypes)._def

	if (
		def.typeName === 'ZodString' ||
		def.typeName === 'ZodLiteral' ||
		def.typeName === 'ZodEnum' ||
		def.typeName === 'ZodNativeEnum'
	) {
		schema = z.any()
			.transform(value => coerceString(value))
			.pipe(type)
	} else if (def.typeName === 'ZodNumber') {
		schema = z.any()
			.transform(value =>
				coerceString(value, text =>
					text.trim() === '' ? Number.NaN : Number(text),
				),
			)
			.pipe(type)
	} else if (def.typeName === 'ZodBoolean') {
		schema = z.any()
			.transform(value =>
				coerceString(value, text => (text === 'on' ? true : text)),
			)
			.pipe(type)
	} else if (def.typeName === 'ZodDate') {
		schema = z.any()
			.transform(value =>
				coerceString(value, timestamp => {
					const date = new Date(timestamp)

					if (isNaN(date.getTime())) {
						return timestamp
					}

					return date
				}),
			)
			.pipe(type)
	} else if (def.typeName === 'ZodBigInt') {
		schema = z.any()
			.transform(value => coerceString(value, BigInt))
			.pipe(type)
	} else if (def.typeName === 'ZodArray') {
		schema = z.any()
			.transform(value => {
				// No preprocess needed if the value is already an array
				if (Array.isArray(value)) {
					return value
				}

				if (
					typeof value === 'undefined' ||
					typeof coerceFile(coerceString(value)) === 'undefined'
				) {
					return []
				}

				// Wrap it in an array otherwise
				return [value]
			})
			.pipe(
				new z.ZodArray({
					...def,
					type: enableTypeCoercion(def.type, cache),
				}),
			)
	} else if (def.typeName === 'ZodObject') {
		const shape = Object.fromEntries(
			Object.entries(def.shape()).map(([key, def]) => [
				key,
				// @ts-expect-error see message above
				enableTypeCoercion(def, cache),
			]),
		)
		schema = new z.ZodObject({
			...def,
			shape: () => shape,
		})
	} else if (def.typeName === 'ZodEffects') {
		if (isFileSchema(type as unknown as z.ZodEffects<any, any, any>)) {
			schema = z.any()
				.transform(value => coerceFile(value))
				.pipe(type)
		} else {
			schema = new z.ZodEffects({
				...def,
				schema: enableTypeCoercion(def.schema, cache),
			})
		}
	} else if (def.typeName === 'ZodOptional') {
		schema = z.any()
			.transform(value => coerceFile(coerceString(value)))
			.pipe(
				new z.ZodOptional({
					...def,
					innerType: enableTypeCoercion(def.innerType, cache),
				}),
			)
	} else if (def.typeName === 'ZodDefault') {
		schema = z.any()
			.transform(value => coerceFile(coerceString(value)))
			.pipe(
				new z.ZodDefault({
					...def,
					innerType: enableTypeCoercion(def.innerType, cache),
				}),
			)
	} else if (def.typeName === 'ZodCatch') {
		schema = new z.ZodCatch({
			...def,
			innerType: enableTypeCoercion(def.innerType, cache),
		})
	} else if (def.typeName === 'ZodIntersection') {
		schema = new z.ZodIntersection({
			...def,
			left: enableTypeCoercion(def.left, cache),
			right: enableTypeCoercion(def.right, cache),
		})
	} else if (def.typeName === 'ZodUnion') {
		schema = new z.ZodUnion({
			...def,
			options: def.options.map((option: z.ZodTypeAny) =>
				enableTypeCoercion(option, cache),
			),
		})
	} else if (def.typeName === 'ZodDiscriminatedUnion') {
		schema = new z.ZodDiscriminatedUnion({
			...def,
			options: def.options.map((option: z.ZodTypeAny) =>
				enableTypeCoercion(option, cache),
			),
			optionsMap: new Map(
				Array.from(def.optionsMap.entries()).map(([discriminator, option]) => [
					discriminator,
					enableTypeCoercion(option, cache) as z.ZodDiscriminatedUnionOption<any>,
				]),
			),
		})
	} else if (def.typeName === 'ZodTuple') {
		schema = new z.ZodTuple({
			...def,
			items: def.items.map((item: z.ZodTypeAny) =>
				enableTypeCoercion(item, cache),
			),
		})
	} else if (def.typeName === 'ZodNullable') {
		schema = new z.ZodNullable({
			...def,
			innerType: enableTypeCoercion(def.innerType, cache),
		})
	} else if (def.typeName === 'ZodPipeline') {
		schema = new z.ZodPipeline({
			...def,
			in: enableTypeCoercion(def.in, cache),
			out: enableTypeCoercion(def.out, cache),
		})
	} else if (def.typeName === 'ZodLazy') {
		const inner = def.getter()
		schema = z.lazy(() => enableTypeCoercion(inner, cache))
	}

	if (type !== schema) {
		cache.set(type, schema)
	}

	return schema
}
