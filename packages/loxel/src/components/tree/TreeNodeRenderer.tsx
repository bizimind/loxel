import type { FilesTreeProps, TreeNode } from "./FilesTree";

import { TreeRow } from "./TreeRow";

export type TreeNodeRendererProps = Pick<
  FilesTreeProps,
  | "isPanelActive"
  | "onOpen"
  | "onContextMenu"
  | "labelClassName"
  | "renderLabel"
  | "renderTrailing"
  | "getRowProps"
  | "getRowClassName"
  | "focusedPath"
  | "activePath"
> & {
  node: TreeNode;
  depth: number;
  expandedPaths: ReadonlySet<string>;
  loadingPaths: ReadonlySet<string>;
  compactRoot: boolean;
  resolveChildren: (node: TreeNode) => TreeNode[] | undefined;
  toggleExpanded: (path: string) => void;
};

export function TreeNodeRenderer({
  node,
  depth,
  expandedPaths,
  loadingPaths,
  isPanelActive,
  compactRoot,
  resolveChildren,
  toggleExpanded,
  onOpen,
  onContextMenu,
  labelClassName,
  renderLabel,
  renderTrailing,
  getRowProps,
  getRowClassName,
  focusedPath,
  activePath,
}: TreeNodeRendererProps) {
  const isExpanded = node.isDir && expandedPaths.has(node.path);
  const children = isExpanded ? resolveChildren(node) : undefined;

  let compactedWith: TreeNode | null = null;
  if ((compactRoot || depth > 0) && isExpanded && children?.length === 1 && children[0]!.isDir) {
    compactedWith = children[0]!;
  }

  if (compactedWith) {
    const leafExpanded = expandedPaths.has(compactedWith.path);
    const leafChildren = leafExpanded ? resolveChildren(compactedWith) : undefined;
    const isLoading = loadingPaths.has(node.path) || loadingPaths.has(compactedWith.path);
    const isSelected = compactedWith.path === focusedPath;
    const isActive = compactedWith.path === activePath;
    const combinedName = node.name + " / " + compactedWith.name;
    const label = renderLabel?.(node, compactedWith);

    return (
      <>
        <TreeRow
          path={compactedWith.path}
          name={combinedName}
          depth={depth}
          isDir
          isExpanded={leafExpanded}
          isSelected={isSelected}
          isActive={isActive}
          isPanelActive={isPanelActive}
          isLoading={isLoading}
          label={label}
          labelClassName={labelClassName?.(compactedWith)}
          trailing={renderTrailing?.(compactedWith)}
          buttonProps={getRowProps?.(compactedWith)}
          buttonClassName={getRowClassName?.(compactedWith)}
          onClick={() => {
            if (leafExpanded) {
              toggleExpanded(compactedWith.path);
            } else {
              if (!expandedPaths.has(node.path)) toggleExpanded(node.path);
              if (!expandedPaths.has(compactedWith.path)) toggleExpanded(compactedWith.path);
            }
          }}
          onContextMenu={
            onContextMenu ? (e) => onContextMenu(e, compactedWith.path, true) : undefined
          }
        />
        {leafExpanded &&
          leafChildren?.map((child) => (
            <TreeNodeRenderer
              key={child.path}
              node={child}
              depth={depth + 2}
              expandedPaths={expandedPaths}
              loadingPaths={loadingPaths}
              isPanelActive={isPanelActive}
              compactRoot={compactRoot}
              resolveChildren={resolveChildren}
              toggleExpanded={toggleExpanded}
              onOpen={onOpen}
              onContextMenu={onContextMenu}
              labelClassName={labelClassName}
              renderLabel={renderLabel}
              renderTrailing={renderTrailing}
              getRowProps={getRowProps}
              getRowClassName={getRowClassName}
              focusedPath={focusedPath}
              activePath={activePath}
            />
          ))}
      </>
    );
  }

  const isLoading = loadingPaths.has(node.path);
  const isSelected = node.path === focusedPath;
  const isActive = node.path === activePath;

  return (
    <>
      <TreeRow
        path={node.path}
        name={node.name}
        depth={depth}
        isDir={node.isDir}
        isExpanded={isExpanded}
        isSelected={isSelected}
        isActive={isActive}
        isPanelActive={isPanelActive}
        isLoading={isLoading}
        label={renderLabel?.(node)}
        labelClassName={labelClassName?.(node)}
        trailing={renderTrailing?.(node)}
        buttonProps={getRowProps?.(node)}
        buttonClassName={getRowClassName?.(node)}
        onClick={() => {
          if (node.isDir) {
            toggleExpanded(node.path);
          }
        }}
        onDoubleClick={() => {
          if (!node.isDir) onOpen(node.path);
        }}
        onContextMenu={onContextMenu ? (e) => onContextMenu(e, node.path, node.isDir) : undefined}
      />
      {isExpanded &&
        children?.map((child) => (
          <TreeNodeRenderer
            key={child.path}
            node={child}
            depth={depth + 1}
            expandedPaths={expandedPaths}
            loadingPaths={loadingPaths}
            isPanelActive={isPanelActive}
            compactRoot={compactRoot}
            resolveChildren={resolveChildren}
            toggleExpanded={toggleExpanded}
            onOpen={onOpen}
            onContextMenu={onContextMenu}
            labelClassName={labelClassName}
            renderLabel={renderLabel}
            renderTrailing={renderTrailing}
            getRowProps={getRowProps}
            getRowClassName={getRowClassName}
            focusedPath={focusedPath}
            activePath={activePath}
          />
        ))}
    </>
  );
}
