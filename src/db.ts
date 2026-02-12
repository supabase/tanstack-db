/* biome-ignore-all lint/suspicious/noExplicitAny: PostgrestFilterBuilder requires database schema types which are not available without codegen */
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { PostgrestFilterBuilder } from "@supabase/postgrest-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { QueryClient } from "@tanstack/query-core";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { type Collection } from "@tanstack/react-db";
import {
  subsetOptionsToQueryKey,
  supabaseOnDelete,
  supabaseOnInsert,
  supabaseOnUpdate,
  supabaseQueryFn,
} from "./functions";
import { getQueryClient } from "./query-client";

type GenericPostgrestFilterBuilder = PostgrestFilterBuilder<
  any,
  any,
  any,
  any,
  any,
  any,
  any
>;

interface SupabaseCollectionOptions<
  TSchema extends StandardSchemaV1,
  TKey extends string | number,
> {
  /** The name of the table in the database */
  tableName: string;
  /** The function to extract the key from the item, used for storing the item in the collection */
  getKey: (item: StandardSchemaV1.InferOutput<TSchema>) => TKey;
  /** The function to build the where clause for the postgrest-js query, used for update and delete operations */
  where: (
    query: GenericPostgrestFilterBuilder,
    item: StandardSchemaV1.InferOutput<TSchema>,
  ) => GenericPostgrestFilterBuilder;
  /** The schema of the collection */
  schema: TSchema;
  /** The query client */
  queryClient?: QueryClient;
  /** The supabase browser client */
  supabase: SupabaseClient;
}

export const supabaseCollectionOptions = <
  TSchema extends StandardSchemaV1,
  TKey extends string | number,
>({
  tableName,
  getKey,
  where,
  schema,
  queryClient,
  supabase,
}: SupabaseCollectionOptions<TSchema, TKey>) => {
  // if the query client is not provided, use the global query client
  queryClient = queryClient ?? getQueryClient();

  return queryCollectionOptions({
    queryClient,
    getKey,
    schema,
    queryKey: (ctx) => subsetOptionsToQueryKey(tableName, ctx),
    syncMode: "on-demand",
    queryFn: (ctx) => supabaseQueryFn(supabase, tableName, ctx),
    onInsert: (ctx) => supabaseOnInsert(supabase, tableName, ctx),
    onUpdate: (ctx) => supabaseOnUpdate(supabase, tableName, where, ctx),
    onDelete: (ctx) => supabaseOnDelete(supabase, tableName, where, ctx),
  });
};

const attachSupabaseListeners = <
  T extends object,
  TKey extends string | number,
>(
  supabase: SupabaseClient,
  tableName: string,
  collection: Collection<T, TKey>,
) => {
  if (!supabase.channel) {
    console.log("Server supabase doesn't have a channel");
    return;
  }

  supabase
    .channel(tableName)
    .on<T>(
      "postgres_changes",
      { event: "*", schema: "public", table: tableName },
      async (payload) => {
        if (payload.eventType === "INSERT") {
          collection.utils.writeInsert(payload.new);
        } else if (payload.eventType === "UPDATE") {
          collection.utils.writeUpdate(payload.new);
        } else if (payload.eventType === "DELETE") {
          const id = collection.getKeyFromItem(payload.old as T);
          if (collection.has(id)) {
            collection.utils.writeDelete(id);
          }
        }
      },
    )
    .subscribe();
};
