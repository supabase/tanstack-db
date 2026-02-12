/** biome-ignore-all lint/complexity/noForEach: <explanation> */
import type { PostgrestFilterBuilder } from "@supabase/postgrest-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { QueryClient, QueryMeta } from "@tanstack/query-core";
import {
	type DeleteMutationFnParams,
	extractSimpleComparisons,
	type InsertMutationFnParams,
	type LoadSubsetOptions,
	parseLoadSubsetOptions,
	parseOrderByExpression,
	parseWhereExpression,
	type SimpleComparison,
	type UpdateMutationFnParams,
} from "@tanstack/react-db";

const buildQuery = (
	baseQuery: PostgrestFilterBuilder<any, any, any, any, any, any, any>,
	filter: SimpleComparison,
) => {
	if (filter.operator === "eq") {
		baseQuery = baseQuery.eq(filter.field?.join("."), filter.value);
	} else if (filter.operator === "gt") {
		baseQuery = baseQuery.gt(filter.field?.join("."), filter.value);
	} else if (filter.operator === "gte") {
		baseQuery = baseQuery.gte(filter.field?.join("."), filter.value);
	} else if (filter.operator === "lt") {
		baseQuery = baseQuery.lt(filter.field.join("."), filter.value);
	} else if (filter.operator === "lte") {
		baseQuery = baseQuery.lte(filter.field.join("."), filter.value);
	} else if (filter.operator === "in") {
		baseQuery = baseQuery.in(filter.field.join("."), filter.value);
	} else if (filter.operator === "isNull") {
		baseQuery = baseQuery.is(filter.field.join("."), null);
	} else if (filter.operator === "not_eq") {
		baseQuery = baseQuery.not(filter.field?.join("."), "eq", filter.value);
	} else {
		console.warn(`buildQuery: unsupported operator: ${filter.operator}`);
	}
};

export const subsetOptionsToQueryKey = (
	tableName: string,
	ctx: LoadSubsetOptions,
) => {
	const filters =
		parseWhereExpression(ctx.where, {
			handlers: {
				eq: (field, value) => {
					return `${field.join(".")}=eq.${value}`;
				},
				or: (field, value) => {
					return `or(${field},${value})`;
				},
				isNull: (field) => `${field.join(".")}=is.null`,
				in: (field, value) => {
					const uniqueValues = Array.from(new Set(value));
					return `${field.join(".")}=in.${uniqueValues}`;
				},
				and: (...filters) => {
					return `${filters.map((filter) => filter).join("&")}`;
				},
			},
			onUnknownOperator: (operator, args) => {
				console.warn(`Unsupported operator: ${operator}`);
				return null;
			},
		}) || [];

	const sorts = parseOrderByExpression(ctx.orderBy);
	const limit = ctx.limit;

	const a = [
		tableName,
		filters,
		sorts.map((sort) => `${sort.field.join(".")}:${sort.direction}`),
		limit,
	];
	return a;
};

export const supabaseQueryFn = async (
	supabase: SupabaseClient,
	tableName: string,
	ctx: {
		client: QueryClient;
		queryKey: readonly unknown[];
		signal: AbortSignal;
		meta: QueryMeta | undefined;
		pageParam?: unknown;
		direction?: unknown;
	},
) => {
	const { limit, orderBy, offset, where, cursor } =
		ctx.meta?.loadSubsetOptions || {};

	let cursorFilters: SimpleComparison[] = [];
	if (cursor) {
		cursorFilters = [...extractSimpleComparisons(cursor.whereFrom)];
	}
	// Parse the expressions into simple format
	const parsed = parseLoadSubsetOptions({ orderBy, limit, where });
	// console.log(tableName, parsed);
	// console.log(tableName, cursorFilters);

	let baseQuery = supabase.from(tableName).select("*");

	if (parsed.limit) {
		baseQuery = baseQuery.limit(parsed.limit);
	}

	if (offset) {
		baseQuery = baseQuery.range(offset, offset + 5);
	}
	if (parsed.sorts) {
		parsed.sorts.forEach((sort) => {
			baseQuery = baseQuery.order(sort.field.join("."), {
				ascending: sort.direction === "asc",
			});
		});
	}

	if (parsed.filters) {
		[...parsed.filters, ...cursorFilters].forEach((filter) => {
			buildQuery(baseQuery, filter);
		});
	}

	const { data, error } = await baseQuery;

	if (error) throw error;
	return data || [];
};

export const supabaseOnInsert = async (
	supabase: SupabaseClient,
	tableName: string,
	{ transaction, collection }: InsertMutationFnParams<any, any, any>,
) => {
	await Promise.all(
		transaction.mutations.map(async (mutation) => {
			const { data, error } = await supabase
				.from(tableName)
				.insert({
					...mutation.modified,
				})
				.select()
				.single();

			if (error) throw error;
			mutation.modified = data;
			// The data has been inserted and confirmed by the server, so we can write it to the collection
			collection.utils.writeInsert(data);
		}),
	);

	return { refetch: false };
};

export const supabaseOnUpdate = async (
	supabase: SupabaseClient,
	tableName: string,
	filter: (
		query: PostgrestFilterBuilder<any, any, any, any, any, any, any>,
		item: any,
	) => PostgrestFilterBuilder<any, any, any, any, any, any, any>,
	{ transaction, collection }: UpdateMutationFnParams<any, any, any>,
) => {
	await Promise.all(
		transaction.mutations.map(async (mutation) => {
			const { original, changes } = mutation;
			const { error, data } = await filter(
				supabase.from(tableName).update({
					...original,
					...changes,
				}),
				mutation.original,
			)
				.select()
				.single();

			if (error) throw error;
			mutation.modified = data;
			collection.utils.writeUpdate(data);
		}),
	);

	return { refetch: false };
};

export const supabaseOnDelete = async (
	supabase: SupabaseClient,
	tableName: string,
	filter: (
		query: PostgrestFilterBuilder<any, any, any, any>,
		item: any,
	) => PostgrestFilterBuilder<any, any, any, any>,
	{ transaction, collection }: DeleteMutationFnParams<any, any, any>,
) => {
	await Promise.all(
		transaction.mutations.map(async (mutation) => {
			const { error } = await filter(
				supabase.from(tableName).delete(),
				mutation.original,
			);

			if (error) throw error;
			// The data has been deleted and confirmed by the server, so we can write it to the collection
			collection.utils.writeDelete(
				collection.getKeyFromItem(mutation.original),
			);
		}),
	);

	return { refetch: false };
};
