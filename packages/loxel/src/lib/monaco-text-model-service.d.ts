/**
 * Narrow ambient typing for the Monaco internals `peek-text-models.ts` uses to resolve models for
 * peek widgets: the standalone service registry, the text model service and the `TextModel` class.
 * The modules are reachable through monaco-editor's `./*` export map but ship without
 * declarations. Only that surface is declared. Verified against monaco-editor 0.57.0;
 * `peek-text-models.test.ts` exercises it against the real services to catch drift on upgrades.
 */
declare module "monaco-editor/platform/instantiation/common/instantiation.js" {
  import type { editor, Uri } from "monaco-editor";
  import type {
    TextModel,
    TextModelCreationOptions,
  } from "monaco-editor/editor/common/model/textModel.js";

  /** A service's decorator: the key the service registry knows it by. */
  export interface ServiceIdentifier<T> {
    readonly type: T;
  }

  export interface IInstantiationService {
    /** Constructs a `TextModel`, injecting the services its constructor takes after these. */
    createInstance(
      ctor: typeof TextModel,
      source: string,
      languageId: string,
      creationOptions: TextModelCreationOptions,
      associatedResource: Uri,
    ): editor.ITextModel;
  }

  export const IInstantiationService: ServiceIdentifier<IInstantiationService>;
}

declare module "monaco-editor/editor/standalone/browser/standaloneServices.js" {
  import type { ServiceIdentifier } from "monaco-editor/platform/instantiation/common/instantiation.js";

  export const StandaloneServices: { get<T>(id: ServiceIdentifier<T>): T };
}

declare module "monaco-editor/editor/common/services/resolverService.js" {
  import type { editor, Uri } from "monaco-editor";
  import type { ServiceIdentifier } from "monaco-editor/platform/instantiation/common/instantiation.js";

  /** A counted hold on a model; Monaco's consumers only read `object.textEditorModel`. */
  export interface TextModelReference {
    readonly object: { readonly textEditorModel: editor.ITextModel };
    dispose(): void;
  }

  /** How Monaco's peek widgets, hover previews and model commands get a URI's model. */
  export interface ITextModelService {
    createModelReference(resource: Uri): Promise<TextModelReference>;
  }

  export const ITextModelService: ServiceIdentifier<ITextModelService>;
}

declare module "monaco-editor/editor/common/model/textModel.js" {
  export interface TextModelCreationOptions {
    readonly isForSimpleWidget: boolean;
  }

  /** Only used as a constructor for `IInstantiationService.createInstance`. */
  export const TextModel: { readonly DEFAULT_CREATION_OPTIONS: TextModelCreationOptions };
}
