import { action, Action } from '@google-genkit/common';
import * as registry from '@google-genkit/common/registry';
import * as z from 'zod';

const BaseDocumentSchema = z.object({
  metadata: z.record(z.string(), z.any()).optional(),
});

export const TextDocumentSchema = BaseDocumentSchema.extend({
  content: z.string(),
});
export type TextDocument = z.infer<typeof TextDocumentSchema>;

export const MulipartDocumentSchema = BaseDocumentSchema.extend({
  content: z.object({
    mimeType: z.string(),
    data: z.string(),
    blob: z.instanceof(Blob).optional(),
  }),
});

type DocumentSchemaType =
  | typeof TextDocumentSchema
  | typeof MulipartDocumentSchema;
type Document = z.infer<DocumentSchemaType>;

type RetrieverFn<
  InputType extends z.ZodTypeAny,
  RetrieverOptions extends z.ZodTypeAny
> = (
  input: z.infer<InputType>,
  queryOpts: z.infer<RetrieverOptions>
) => Promise<Array<Document>>;

type IndexerFn<IndexerOptions extends z.ZodTypeAny> = (
  docs: Array<Document>,
  indexerOpts: z.infer<IndexerOptions>
) => Promise<void>;

export type RetrieverAction<
  I extends z.ZodTypeAny,
  O extends z.ZodTypeAny,
  QueryType extends z.ZodTypeAny,
  DocType extends z.ZodTypeAny,
  CustomOptions extends z.ZodTypeAny
> = Action<I, O> & {
  __queryType: QueryType;
  __docType: DocType;
  __customOptionsType: CustomOptions;
};

export type IndexerAction<
  I extends z.ZodTypeAny,
  O extends z.ZodTypeAny,
  DocType extends z.ZodTypeAny,
  CustomOptions extends z.ZodTypeAny
> = Action<I, O> & {
  __docType: DocType;
  __customOptionsType: CustomOptions;
};

/**
 * Encapsulation of both {@link RetrieverAction} and {@link IndexerAction}.
 */
export interface DocumentStore<
  QueryType extends z.ZodTypeAny,
  RetrieverOptions extends z.ZodTypeAny,
  IndexerOptions extends z.ZodTypeAny
> {
  (params: {
    query: z.infer<QueryType>;
    options: z.infer<RetrieverOptions>;
  }): Promise<Array<Document>>;
  index: (params: {
    docs: Array<Document>;
    options: z.infer<IndexerOptions>;
  }) => Promise<void>;
}

function retrieverWithMetadata<
  I extends z.ZodTypeAny,
  O extends z.ZodTypeAny,
  QueryType extends z.ZodTypeAny,
  DocType extends z.ZodTypeAny,
  CustomOptions extends z.ZodTypeAny
>(
  retriever: Action<I, O>,
  queryType: QueryType,
  docType: DocType,
  customOptionsType: CustomOptions
): RetrieverAction<I, O, QueryType, DocType, CustomOptions> {
  const withMeta = retriever as RetrieverAction<
    I,
    O,
    QueryType,
    DocType,
    CustomOptions
  >;
  withMeta.__queryType = queryType;
  withMeta.__docType = docType;
  withMeta.__customOptionsType = customOptionsType;
  return withMeta;
}

function indexerWithMetadata<
  I extends z.ZodTypeAny,
  O extends z.ZodTypeAny,
  DocType extends z.ZodTypeAny,
  CustomOptions extends z.ZodTypeAny
>(
  indexer: Action<I, O>,
  docType: DocType,
  customOptionsType: CustomOptions
): IndexerAction<I, O, DocType, CustomOptions> {
  const withMeta = indexer as IndexerAction<I, O, DocType, CustomOptions>;
  withMeta.__docType = docType;
  withMeta.__customOptionsType = customOptionsType;
  return withMeta;
}

/**
 *  Creates a retriever action for the provided {@link RetrieverFn} implementation.
 */
export function retrieverFactory<
  InputType extends z.ZodTypeAny,
  RetrieverOptions extends z.ZodTypeAny
>(
  provider: string,
  retrieverId: string,
  inputType: InputType,
  documentType: DocumentSchemaType,
  customOptionsType: RetrieverOptions,
  fn: RetrieverFn<InputType, RetrieverOptions>
) {
  const retriever = action(
    {
      name: 'retrieve',
      input: z.object({
        query: inputType,
        options: customOptionsType,
      }),
      output: z.array(documentType),
    },
    (i) => fn(i.query, i.options)
  );
  registry.registerAction('retriever', `${provider}/${retrieverId}`, retriever);
  return retrieverWithMetadata(
    retriever,
    inputType,
    documentType,
    customOptionsType
  );
}

/**
 *  Creates an indexer action for the provided {@link IndexerFn} implementation.
 */
export function indexerFactory<IndexerOptions extends z.ZodTypeAny>(
  provider: string,
  indexerId: string,
  documentType: DocumentSchemaType,
  customOptionsType: IndexerOptions,
  fn: IndexerFn<IndexerOptions>
) {
  const indexer = action(
    {
      name: 'index',
      input: z.object({
        docs: z.array(documentType),
        options: customOptionsType,
      }),
      output: z.void(),
    },
    (i) => fn(i.docs, i.options)
  );
  registry.registerAction('indexer', `${provider}/${indexerId}`, indexer);
  return indexerWithMetadata(indexer, documentType, customOptionsType);
}

/**
 * Creates a {@link DocumentStore} based on provided {@link RetrieverFn} and {@link IndexerFn}.
 */
export function documentStoreFactory<
  IndexerOptions extends z.ZodTypeAny,
  InputType extends z.ZodTypeAny,
  RetrieverOptions extends z.ZodTypeAny
>(params: {
  provider: string;
  id: string;
  inputType: InputType;
  documentType: DocumentSchemaType;
  retrieverOptionsType: RetrieverOptions;
  indexerOptionsType: IndexerOptions;
  retrieveFn: RetrieverFn<InputType, RetrieverOptions>;
  indexFn: IndexerFn<IndexerOptions>;
}) {
  const indexer = indexerFactory(
    params.provider,
    params.id,
    params.documentType,
    params.indexerOptionsType,
    params.indexFn
  );
  const retriever = retrieverFactory(
    params.provider,
    params.id,
    params.inputType,
    params.documentType,
    params.retrieverOptionsType,
    params.retrieveFn
  );

  const store = ((params: {
    query: z.infer<InputType>;
    options: z.infer<RetrieverOptions>;
  }) =>
    retriever({
      query: params.query,
      options: params.options,
    })) as DocumentStore<InputType, RetrieverOptions, IndexerOptions>;
  const documentType = params.documentType;
  store.index = (params: {
    docs: Array<z.infer<typeof documentType>>;
    options: z.infer<IndexerOptions>;
  }) => indexer({ docs: params.docs, options: params.options });
  return store;
}

/**
 * Retrieves documents from a {@link RetrieverAction} or {@link DocumentStore}
 * based on the provided query.
 */
export async function retrieve<
  I extends z.ZodTypeAny,
  O extends z.ZodTypeAny,
  QueryType extends z.ZodTypeAny,
  DocType extends z.ZodTypeAny,
  CustomOptions extends z.ZodTypeAny,
  IndexerOptions extends z.ZodTypeAny
>(params: {
  retriever:
    | DocumentStore<QueryType, CustomOptions, IndexerOptions>
    | RetrieverAction<I, O, QueryType, DocType, CustomOptions>;
  query: z.infer<QueryType>;
  options?: z.infer<CustomOptions>;
}): Promise<Array<z.infer<DocType>>> {
  return await params.retriever({
    query: params.query,
    options: params.options,
  });
}

/**
 * Indexes documents using a {@link IndexerAction} or a {@link DocumentStore}.
 */
export async function index<
  I extends z.ZodTypeAny,
  O extends z.ZodTypeAny,
  QueryType extends z.ZodTypeAny,
  DocType extends z.ZodTypeAny,
  CustomOptions extends z.ZodTypeAny,
  IndexerOptions extends z.ZodTypeAny
>(params: {
  indexer:
    | DocumentStore<QueryType, CustomOptions, IndexerOptions>
    | IndexerAction<I, O, DocType, CustomOptions>;
  docs: Array<z.infer<DocType>>;
  options?: z.infer<CustomOptions>;
}): Promise<void> {
  if (
    'index' in params.indexer &&
    typeof params.indexer['index'] === 'function'
  ) {
    return await params.indexer.index({
      docs: params.docs,
      options: params.options,
    });
  }
  return await (params.indexer as IndexerAction<I, O, DocType, CustomOptions>)({
    docs: params.docs,
    options: params.options,
  });
}

export const CommonRetrieverOptionsSchema = z.object({
  k: z.number().describe('Number of documents to retrieve').optional(),
});

export const CommonIndexerOptionsSchema = z.object({});