import { MigrationTrack } from '../types';

/**
 * openai-node v3 → v4 track, derived from the official v4 migration guide
 * (https://github.com/openai/openai-node/discussions/217) and the v4 README.
 *
 * The v4 SDK restructured the client: every resource moved from a flat method
 * on the client (`openai.createCompletion`) to a namespaced resource
 * (`openai.completions.create`), and construction changed from
 * `new OpenAIApi(new Configuration({...}))` to `new OpenAI({ apiKey })`.
 *
 * The flat-method renames are 100% deterministic (method-move rules). The
 * construction change needs the guide-constrained LLM engine because the
 * Configuration object must be inlined/reshaped — rules never guess that.
 * Removals with no mechanical equivalent (createEdit, createFineTune,
 * createAnswer) are deliberately NOT in the registry: they are semantic
 * decisions the human must make, and MigratePR never fabricates a migration
 * for a deleted API.
 */
export const OPENAI_TRACKS: MigrationTrack[] = [
  {
    id: 'openai-v3-to-v4',
    vendor: 'openai',
    sdkModule: 'openai',
    sdkFrom: 3,
    sdkTo: 4,
    apiFrom: 'v3 (flat methods)',
    apiTo: 'v4 (namespaced resources)',
    guideUrls: [
      'https://github.com/openai/openai-node/discussions/217',
      'https://github.com/openai/openai-node/blob/master/README.md',
    ],
    rules: [
      {
        id: 'openai-v3-to-v4:create-completion',
        kind: 'method-move',
        fromResource: '',
        from: 'createCompletion',
        to: 'completions.create',
        summary:
          'In openai v4, `createCompletion` moved to the `completions` resource: `openai.createCompletion(...)` → `openai.completions.create(...)`.',
        guideUrl: 'https://github.com/openai/openai-node/discussions/217',
        risk: 'mechanical',
      },
      {
        id: 'openai-v3-to-v4:create-chat-completion',
        kind: 'method-move',
        fromResource: '',
        from: 'createChatCompletion',
        to: 'chat.completions.create',
        summary:
          'In openai v4, `createChatCompletion` moved to `chat.completions`: `openai.createChatCompletion(...)` → `openai.chat.completions.create(...)`.',
        guideUrl: 'https://github.com/openai/openai-node/discussions/217',
        risk: 'mechanical',
      },
      {
        id: 'openai-v3-to-v4:create-image',
        kind: 'method-move',
        fromResource: '',
        from: 'createImage',
        to: 'images.generate',
        summary:
          'In openai v4, `createImage` was renamed to `images.generate`.',
        guideUrl: 'https://github.com/openai/openai-node/discussions/217',
        risk: 'mechanical',
      },
      {
        id: 'openai-v3-to-v4:create-embedding',
        kind: 'method-move',
        fromResource: '',
        from: 'createEmbedding',
        to: 'embeddings.create',
        summary:
          'In openai v4, `createEmbedding` moved to `embeddings.create`.',
        guideUrl: 'https://github.com/openai/openai-node/discussions/217',
        risk: 'mechanical',
      },
      {
        id: 'openai-v3-to-v4:create-moderation',
        kind: 'method-move',
        fromResource: '',
        from: 'createModeration',
        to: 'moderations.create',
        summary:
          'In openai v4, `createModeration` moved to `moderations.create`.',
        guideUrl: 'https://github.com/openai/openai-node/discussions/217',
        risk: 'mechanical',
      },
      {
        id: 'openai-v3-to-v4:list-models',
        kind: 'method-move',
        fromResource: '',
        from: 'listModels',
        to: 'models.list',
        summary:
          'In openai v4, `listModels` moved to `models.list`.',
        guideUrl: 'https://github.com/openai/openai-node/discussions/217',
        risk: 'mechanical',
      },
      {
        id: 'openai-v3-to-v4:retrieve-model',
        kind: 'method-move',
        fromResource: '',
        from: 'retrieveModel',
        to: 'models.retrieve',
        summary:
          'In openai v4, `retrieveModel` moved to `models.retrieve`.',
        guideUrl: 'https://github.com/openai/openai-node/discussions/217',
        risk: 'mechanical',
      },
      {
        id: 'openai-v3-to-v4:create-file',
        kind: 'method-move',
        fromResource: '',
        from: 'createFile',
        to: 'files.create',
        summary:
          'In openai v4, `createFile` moved to `files.create`.',
        guideUrl: 'https://github.com/openai/openai-node/discussions/217',
        risk: 'mechanical',
      },
      {
        id: 'openai-v3-to-v4:create-transcription',
        kind: 'method-move',
        fromResource: '',
        from: 'createTranscription',
        to: 'audio.transcriptions.create',
        summary:
          'In openai v4, `createTranscription` moved to `audio.transcriptions.create`.',
        guideUrl: 'https://github.com/openai/openai-node/discussions/217',
        risk: 'mechanical',
      },
      {
        id: 'openai-v3-to-v4:create-translation',
        kind: 'method-move',
        fromResource: '',
        from: 'createTranslation',
        to: 'audio.translations.create',
        summary:
          'In openai v4, `createTranslation` moved to `audio.translations.create`.',
        guideUrl: 'https://github.com/openai/openai-node/discussions/217',
        risk: 'mechanical',
      },
      {
        id: 'openai-v3-to-v4:client-constructor',
        kind: 'client-constructor',
        from: 'OpenAIApi',
        to: 'OpenAI',
        needsLlm: true,
        summary:
          'openai v4 replaced `new OpenAIApi(new Configuration({ apiKey, ... }))` with `new OpenAI({ apiKey, ... })` — the Configuration wrapper is gone and options moved onto the client constructor. Rewritten by the LLM constrained by the official guide; review the resulting constructor call.',
        guideUrl: 'https://github.com/openai/openai-node/discussions/217',
        guideExcerpt:
          'With the v4 release the SDK was rewritten in TypeScript. The client is now constructed directly: const client = new OpenAI({ apiKey }); — there is no separate Configuration class anymore, and flat methods like openai.createCompletion became namespaced: client.completions.create(...).',
        risk: 'semantic',
      },
      {
        id: 'openai-v3-to-v4:sdk-bump-v4',
        kind: 'sdk-bump',
        packageName: 'openai',
        to: '^4.0.0',
        summary: 'Bump the openai dependency to ^4.',
        guideUrl: 'https://www.npmjs.com/package/openai',
        risk: 'mechanical',
      },
    ],
  },
];