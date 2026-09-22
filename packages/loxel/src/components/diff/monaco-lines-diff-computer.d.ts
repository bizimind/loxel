/**
 * Narrow ambient typing for Monaco's bundled VS Code diff computer. The module is reachable
 * through monaco-editor's `./*` export map but ships without declarations. Only the surface
 * used by `inline-changes.ts` is declared here. Verified against monaco-editor 0.56.0; the
 * behavioral tests in `inline-changes.test.ts` guard against drift on upgrades.
 */
declare module "monaco-editor/editor/common/diff/defaultLinesDiffComputer/defaultLinesDiffComputer" {
  import type { IRange } from "monaco-editor";

  export interface LinesDiffComputerOptions {
    ignoreTrimWhitespace: boolean;
    maxComputationTimeMs: number;
    computeMoves: boolean;
    extendToSubwords?: boolean;
  }

  export interface InnerRangeMapping {
    originalRange: IRange;
    modifiedRange: IRange;
  }

  export interface DetailedLineRangeMapping {
    innerChanges: InnerRangeMapping[] | undefined;
  }

  export interface LinesDiff {
    changes: DetailedLineRangeMapping[];
    hitTimeout: boolean;
  }

  export class DefaultLinesDiffComputer {
    computeDiff(
      originalLines: string[],
      modifiedLines: string[],
      options: LinesDiffComputerOptions,
    ): LinesDiff;
  }
}
