import type { ReactNode } from "react";
import { EmptyState, Badge, type UseCase } from "../ui";

export interface PlaceholderProps {
  title: string;
  description: ReactNode;
  /** What is expected to replace this surface, e.g. "src/usecases/build". */
  owner?: string;
  useCase?: UseCase | null;
  glyph?: string;
}

/**
 * A workflow surface that has not been built yet. Sibling agents replace these
 * with real views; the shell's routing and chrome stay exactly as they are.
 */
export function Placeholder({
  title,
  description,
  owner,
  useCase,
  glyph = "⌸",
}: PlaceholderProps) {
  return (
    <div className="flex h-full flex-col bg-canvas">
      <EmptyState
        glyph={glyph}
        title={title}
        description={
          <>
            <span className="block">{description}</span>
            {useCase ? (
              <span className="mt-2 flex items-center justify-center gap-1.5">
                <Badge mono>{useCase.code}</Badge>
                <span className="text-ink-3">{useCase.label}</span>
              </span>
            ) : null}
            {owner ? (
              <span className="mt-2 block font-mono text-2xs text-ink-3">
                lands in {owner}
              </span>
            ) : null}
          </>
        }
      />
    </div>
  );
}
