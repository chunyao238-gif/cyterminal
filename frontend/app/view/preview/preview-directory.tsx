// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { ContextMenuModel } from "@/app/store/contextmenu";
import { globalStore } from "@/app/store/jotaiStore";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { useWaveEnv } from "@/app/waveenv/waveenv";
import { checkKeyPressed, isCharacterKeyEvent } from "@/util/keyutil";
import { PLATFORM, PlatformMacOS } from "@/util/platformutil";
import { addOpenMenuItems } from "@/util/previewutil";
import { arrayToBase64, fireAndForget } from "@/util/util";
import { formatRemoteUri } from "@/util/waveutil";
import { offset, useDismiss, useFloating, useInteractions } from "@floating-ui/react";
import {
    Header,
    Row,
    RowData,
    Table,
    createColumnHelper,
    flexRender,
    getCoreRowModel,
    getSortedRowModel,
    useReactTable,
} from "@tanstack/react-table";
import clsx from "clsx";
import { PrimitiveAtom, atom, useAtom, useAtomValue, useSetAtom } from "jotai";
import { OverlayScrollbarsComponent, OverlayScrollbarsComponentRef } from "overlayscrollbars-react";
import React, { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDrag, useDrop } from "react-dnd";
import { quote as shellQuote } from "shell-quote";
import { debounce } from "throttle-debounce";
import "./directorypreview.scss";
import { EntryManagerOverlay, EntryManagerOverlayProps, EntryManagerType } from "./entry-manager";
import {
    cleanMimetype,
    getBestUnit,
    getLastModifiedTime,
    getSortIcon,
    handleFileDelete,
    handleRename,
    isIconValid,
    makeDirectoryDefaultMenuItems,
    mergeError,
    overwriteError,
} from "./preview-directory-utils";
import { type PreviewModel } from "./preview-model";
import type { PreviewEnv } from "./previewenv";

const PageJumpSize = 20;

interface DirectoryTableHeaderCellProps {
    header: Header<FileInfo, unknown>;
}

function DirectoryTableHeaderCell({ header }: DirectoryTableHeaderCellProps) {
    return (
        <div
            className="dir-table-head-cell"
            key={header.id}
            style={{ width: `calc(var(--header-${header.id}-size) * 1px)` }}
        >
            <div className="dir-table-head-cell-content" onClick={() => header.column.toggleSorting()}>
                {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                {getSortIcon(header.column.getIsSorted())}
            </div>
            <div className="dir-table-head-resize-box">
                <div
                    className="dir-table-head-resize"
                    onMouseDown={header.getResizeHandler()}
                    onTouchStart={header.getResizeHandler()}
                />
            </div>
        </div>
    );
}

declare module "@tanstack/react-table" {
    interface TableMeta<TData extends RowData> {
        updateName: (path: string, isDir: boolean) => void;
        newFile: () => void;
        newDirectory: () => void;
    }
}

interface DirectoryTableProps {
    model: PreviewModel;
    data: FileInfo[];
    search: string;
    focusIndex: number;
    setSearch: (_: string) => void;
    setSelectedPath: (_: string) => void;
    setRefreshVersion: React.Dispatch<React.SetStateAction<number>>;
    entryManagerOverlayPropsAtom: PrimitiveAtom<EntryManagerOverlayProps>;
    newFile: () => void;
    newDirectory: () => void;
    selectedIndices: Set<number>;
    onRowClick: (idx: number, e: React.MouseEvent) => void;
}

const columnHelper = createColumnHelper<FileInfo>();

function DirectoryTable({
    model,
    data,
    search,
    focusIndex,
    setSearch,
    setSelectedPath,
    setRefreshVersion,
    entryManagerOverlayPropsAtom,
    newFile,
    newDirectory,
    selectedIndices,
    onRowClick,
}: DirectoryTableProps) {
    const env = useWaveEnv<PreviewEnv>();
    const fullConfig = useAtomValue(env.atoms.fullConfigAtom);
    const defaultSort = useAtomValue(env.getSettingsKeyAtom("preview:defaultsort")) ?? "name";
    const setErrorMsg = useSetAtom(model.errorMsgAtom);
    const getIconFromMimeType = useCallback(
        (mimeType: string): string => {
            while (mimeType.length > 0) {
                const icon = fullConfig.mimetypes?.[mimeType]?.icon ?? null;
                if (isIconValid(icon)) {
                    return `fa fa-solid fa-${icon} fa-fw`;
                }
                mimeType = mimeType.slice(0, -1);
            }
            return "fa fa-solid fa-file fa-fw";
        },
        [fullConfig.mimetypes]
    );
    const getIconColor = useCallback(
        (mimeType: string): string => fullConfig.mimetypes?.[mimeType]?.color ?? "inherit",
        [fullConfig.mimetypes]
    );
    const columns = useMemo(
        () => [
            columnHelper.accessor("mimetype", {
                cell: (info) => (
                    <i
                        className={getIconFromMimeType(info.getValue() ?? "")}
                        style={{ color: getIconColor(info.getValue() ?? "") }}
                    ></i>
                ),
                header: () => <span></span>,
                id: "logo",
                size: 25,
                enableSorting: false,
            }),
            columnHelper.accessor("name", {
                cell: (info) => <span className="dir-table-name ellipsis">{info.getValue()}</span>,
                header: () => <span className="dir-table-head-name">Name</span>,
                sortingFn: "alphanumeric",
                size: 200,
                minSize: 90,
            }),
            columnHelper.accessor("modestr", {
                cell: (info) => <span className="dir-table-modestr">{info.getValue()}</span>,
                header: () => <span>Perm</span>,
                size: 91,
                minSize: 90,
                sortingFn: "alphanumeric",
            }),
            columnHelper.accessor("modtime", {
                cell: (info) => <span className="dir-table-lastmod">{getLastModifiedTime(info.getValue())}</span>,
                header: () => <span>Last Modified</span>,
                size: 91,
                minSize: 65,
                sortingFn: "datetime",
            }),
            columnHelper.accessor("size", {
                cell: (info) => <span className="dir-table-size">{getBestUnit(info.getValue())}</span>,
                header: () => <span className="dir-table-head-size">Size</span>,
                size: 55,
                minSize: 50,
                sortingFn: "auto",
            }),
            columnHelper.accessor("mimetype", {
                cell: (info) => <span className="dir-table-type ellipsis">{cleanMimetype(info.getValue() ?? "")}</span>,
                header: () => <span className="dir-table-head-type">Type</span>,
                size: 97,
                minSize: 97,
                sortingFn: "alphanumeric",
            }),
            columnHelper.accessor("path", {}),
        ],
        [fullConfig]
    );

    const setEntryManagerProps = useSetAtom(entryManagerOverlayPropsAtom);

    const updateName = useCallback(
        (path: string, isDir: boolean) => {
            const fileName = path.split("/").at(-1);
            setEntryManagerProps({
                entryManagerType: EntryManagerType.EditName,
                startingValue: fileName,
                onSave: (newName: string) => {
                    let newPath: string;
                    if (newName !== fileName) {
                        const lastInstance = path.lastIndexOf(fileName);
                        newPath = path.substring(0, lastInstance) + newName;
                        console.log(`replacing ${fileName} with ${newName}: ${path}`);
                        handleRename(model, path, newPath, isDir, setErrorMsg);
                    }
                    setEntryManagerProps(undefined);
                },
            });
        },
        [model, setErrorMsg]
    );

    const initialSorting = defaultSort === "modtime" ? [{ id: "modtime", desc: true }] : [{ id: "name", desc: false }];

    const table = useReactTable({
        data,
        columns,
        columnResizeMode: "onChange",
        getSortedRowModel: getSortedRowModel(),
        getCoreRowModel: getCoreRowModel(),

        initialState: {
            sorting: initialSorting,
            columnVisibility: {
                path: false,
            },
        },
        enableMultiSort: false,
        enableSortingRemoval: false,
        meta: {
            updateName,
            newFile,
            newDirectory,
        },
    });
    const sortingState = table.getState().sorting;
    useEffect(() => {
        const allRows = table.getRowModel()?.flatRows || [];
        setSelectedPath((allRows[focusIndex]?.getValue("path") as string) ?? null);
    }, [focusIndex, data, setSelectedPath, sortingState]);

    const columnSizeVars = useMemo(() => {
        const headers = table.getFlatHeaders();
        const colSizes: { [key: string]: number } = {};
        for (let i = 0; i < headers.length; i++) {
            const header = headers[i]!;
            colSizes[`--header-${header.id}-size`] = header.getSize();
            colSizes[`--col-${header.column.id}-size`] = header.column.getSize();
        }
        return colSizes;
    }, [table.getState().columnSizingInfo]);

    const osRef = useRef<OverlayScrollbarsComponentRef>(null);
    const bodyRef = useRef<HTMLDivElement>(null);
    const [scrollHeight, setScrollHeight] = useState(0);

    const onScroll = useCallback(
        debounce(2, () => {
            setScrollHeight(osRef.current.osInstance().elements().viewport.scrollTop);
        }),
        []
    );

    const TableComponent = table.getState().columnSizingInfo.isResizingColumn ? MemoizedTableBody : TableBody;

    return (
        <OverlayScrollbarsComponent
            options={{ scrollbars: { autoHide: "leave" } }}
            events={{ scroll: onScroll }}
            className="dir-table"
            style={{ ...columnSizeVars }}
            ref={osRef}
            data-scroll-height={scrollHeight}
        >
            <div className="dir-table-head">
                {table.getHeaderGroups().map((headerGroup) => (
                    <div className="dir-table-head-row" key={headerGroup.id}>
                        {headerGroup.headers.map((header) => (
                            <DirectoryTableHeaderCell key={header.id} header={header} />
                        ))}
                    </div>
                ))}
            </div>
            <TableComponent
                bodyRef={bodyRef}
                model={model}
                data={data}
                table={table}
                search={search}
                focusIndex={focusIndex}
                setSearch={setSearch}
                setSelectedPath={setSelectedPath}
                setRefreshVersion={setRefreshVersion}
                osRef={osRef.current}
                selectedIndices={selectedIndices}
                onRowClick={onRowClick}
            />
        </OverlayScrollbarsComponent>
    );
}

interface TableBodyProps {
    bodyRef: React.RefObject<HTMLDivElement>;
    model: PreviewModel;
    data: Array<FileInfo>;
    table: Table<FileInfo>;
    search: string;
    focusIndex: number;
    setSearch: (_: string) => void;
    setSelectedPath: (_: string) => void;
    setRefreshVersion: React.Dispatch<React.SetStateAction<number>>;
    osRef: OverlayScrollbarsComponentRef;
    selectedIndices: Set<number>;
    onRowClick: (idx: number, e: React.MouseEvent) => void;
}

function TableBody({
    bodyRef,
    model,
    table,
    search,
    focusIndex,
    setSearch,
    setRefreshVersion,
    osRef,
    selectedIndices,
    onRowClick,
}: TableBodyProps) {
    const searchActive = useAtomValue(model.directorySearchActive);
    const dummyLineRef = useRef<HTMLDivElement>(null);
    const warningBoxRef = useRef<HTMLDivElement>(null);
    const conn = useAtomValue(model.connection);
    const setErrorMsg = useSetAtom(model.errorMsgAtom);

    useEffect(() => {
        if (focusIndex === null || !bodyRef.current || !osRef) {
            return;
        }

        const rowElement = bodyRef.current.querySelector(`[data-rowindex="${focusIndex}"]`) as HTMLDivElement;
        if (!rowElement) {
            return;
        }

        const viewport = osRef.osInstance().elements().viewport;
        const viewportHeight = viewport.offsetHeight;
        const rowRect = rowElement.getBoundingClientRect();
        const parentRect = viewport.getBoundingClientRect();
        const viewportScrollTop = viewport.scrollTop;
        const rowTopRelativeToViewport = rowRect.top - parentRect.top + viewport.scrollTop;
        const rowBottomRelativeToViewport = rowRect.bottom - parentRect.top + viewport.scrollTop;

        if (rowTopRelativeToViewport - 30 < viewportScrollTop) {
            // Row is above the visible area
            let topVal = rowTopRelativeToViewport - 30;
            if (topVal < 0) {
                topVal = 0;
            }
            viewport.scrollTo({ top: topVal });
        } else if (rowBottomRelativeToViewport + 5 > viewportScrollTop + viewportHeight) {
            // Row is below the visible area
            const topVal = rowBottomRelativeToViewport - viewportHeight + 5;
            viewport.scrollTo({ top: topVal });
        }
    }, [focusIndex]);

    const handleFileContextMenu = useCallback(
        async (e: any, finfo: FileInfo) => {
            e.preventDefault();
            e.stopPropagation();
            if (finfo == null) {
                return;
            }
            const fileName = finfo.path.split("/").pop();
            const menu: ContextMenuItem[] = [
                {
                    label: "New File",
                    click: () => {
                        table.options.meta.newFile();
                    },
                },
                {
                    label: "New Folder",
                    click: () => {
                        table.options.meta.newDirectory();
                    },
                },
                {
                    label: "Rename",
                    click: () => {
                        table.options.meta.updateName(finfo.path, finfo.isdir);
                    },
                },
                {
                    type: "separator",
                },
                {
                    label: "Copy File Name",
                    click: () => fireAndForget(() => navigator.clipboard.writeText(fileName)),
                },
                {
                    label: "Copy Full File Name",
                    click: () => fireAndForget(() => navigator.clipboard.writeText(finfo.path)),
                },
                {
                    label: "Copy File Name (Shell Quoted)",
                    click: () => fireAndForget(() => navigator.clipboard.writeText(shellQuote([fileName]))),
                },
                {
                    label: "Copy Full File Name (Shell Quoted)",
                    click: () => fireAndForget(() => navigator.clipboard.writeText(shellQuote([finfo.path]))),
                },
            ];
            addOpenMenuItems(menu, conn, finfo);
            menu.push(
                {
                    type: "separator",
                },
                {
                    label: "Default Settings",
                    submenu: makeDirectoryDefaultMenuItems(model),
                },
                {
                    type: "separator",
                },
                {
                    label: "Delete",
                    click: () => handleFileDelete(model, finfo.path, false, setErrorMsg),
                }
            );
            ContextMenuModel.getInstance().showContextMenu(menu, e);
        },
        [setRefreshVersion, conn]
    );

    const allRows = table.getRowModel().flatRows;
    const dotdotRow = allRows.find((row) => row.getValue("name") === "..");
    const otherRows = allRows.filter((row) => row.getValue("name") !== "..");

    return (
        <div className="dir-table-body" ref={bodyRef}>
            {(searchActive || search !== "") && (
                <div className="flex rounded-[3px] py-1 px-2 bg-warning text-black" ref={warningBoxRef}>
                    <span>{search === "" ? "Type to search (Esc to cancel)" : `Searching for "${search}"`}</span>
                    <div
                        className="ml-auto bg-transparent flex justify-center items-center flex-col p-0.5 rounded-md hover:bg-hoverbg focus:bg-hoverbg focus-within:bg-hoverbg cursor-pointer"
                        onClick={() => {
                            setSearch("");
                            globalStore.set(model.directorySearchActive, false);
                        }}
                    >
                        <i className="fa-solid fa-xmark" />
                        <input
                            type="text"
                            value={search}
                            onChange={() => {}}
                            className="w-0 h-0 opacity-0 p-0 border-none pointer-events-none"
                        />
                    </div>
                </div>
            )}
            <div className="dir-table-body-scroll-box">
                <div className="dummy dir-table-body-row" ref={dummyLineRef}>
                    <div className="dir-table-body-cell">dummy-data</div>
                </div>
                {dotdotRow && (
                    <TableRow
                        model={model}
                        row={dotdotRow}
                        focusIndex={focusIndex}
                        setSearch={setSearch}
                        idx={0}
                        handleFileContextMenu={handleFileContextMenu}
                        selectedIndices={selectedIndices}
                        onRowClick={onRowClick}
                        key="dotdot"
                    />
                )}
                {otherRows.map((row, idx) => (
                    <TableRow
                        model={model}
                        row={row}
                        focusIndex={focusIndex}
                        setSearch={setSearch}
                        idx={dotdotRow ? idx + 1 : idx}
                        handleFileContextMenu={handleFileContextMenu}
                        selectedIndices={selectedIndices}
                        onRowClick={onRowClick}
                        key={idx}
                    />
                ))}
            </div>
        </div>
    );
}

type TableRowProps = {
    model: PreviewModel;
    row: Row<FileInfo>;
    focusIndex: number;
    setSearch: (_: string) => void;
    idx: number;
    handleFileContextMenu: (e: any, finfo: FileInfo) => Promise<void>;
    selectedIndices: Set<number>;
    onRowClick: (idx: number, e: React.MouseEvent) => void;
};

function TableRow({ model, row, focusIndex, setSearch, idx, handleFileContextMenu, selectedIndices, onRowClick }: TableRowProps) {
    const dirPath = useAtomValue(model.statFilePath);
    const connection = useAtomValue(model.connection);
    const isSelected = selectedIndices.has(idx);

    const dragItem: DraggedFile = {
        relName: row.getValue("name") as string,
        absParent: dirPath,
        uri: formatRemoteUri(row.getValue("path") as string, connection),
        isDir: row.original.isdir,
    };
    const [_, drag] = useDrag(
        () => ({
            type: "FILE_ITEM",
            canDrag: true,
            item: () => dragItem,
        }),
        [dragItem]
    );

    const dragRef = useCallback(
        (node: HTMLDivElement | null) => {
            drag(node);
        },
        [drag]
    );

    return (
        <div
            className={clsx("dir-table-body-row", { focused: focusIndex === idx, selected: isSelected })}
            data-rowindex={idx}
            onDoubleClick={() => {
                const newFileName = row.getValue("path") as string;
                model.goHistory(newFileName);
                setSearch("");
                globalStore.set(model.directorySearchActive, false);
            }}
            onClick={(e) => onRowClick(idx, e)}
            onContextMenu={(e) => handleFileContextMenu(e, row.original)}
            ref={dragRef}
        >
            {row.getVisibleCells().map((cell) => (
                <div
                    className={clsx("dir-table-body-cell", "col-" + cell.column.id)}
                    key={cell.id}
                    style={{ width: `calc(var(--col-${cell.column.id}-size) * 1px)` }}
                >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </div>
            ))}
        </div>
    );
}

const MemoizedTableBody = React.memo(
    TableBody,
    (prev, next) => prev.table.options.data == next.table.options.data && prev.selectedIndices === next.selectedIndices
) as typeof TableBody;

interface DirectoryPreviewProps {
    model: PreviewModel;
}

function DirectoryPreview({ model }: DirectoryPreviewProps) {
    const env = useWaveEnv<PreviewEnv>();
    const [searchText, setSearchText] = useState("");
    const [focusIndex, setFocusIndex] = useState(0);
    const [unfilteredData, setUnfilteredData] = useState<FileInfo[]>([]);
    const showHiddenFiles = useAtomValue(model.showHiddenFiles);
    const [selectedPath, setSelectedPath] = useState("");
    const [refreshVersion, setRefreshVersion] = useAtom(model.refreshVersion);
    const conn = useAtomValue(model.connection);
    const blockData = useAtomValue(model.blockAtom);
    const finfo = useAtomValue(model.statFile);
    const dirPath = finfo?.path;
    const setErrorMsg = useSetAtom(model.errorMsgAtom);
    const [isNativeDragging, setIsNativeDragging] = useState(false);
    const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set());
    const anchorIndexRef = useRef<number | null>(null);
    const [uploadProgress, setUploadProgress] = useState<{ total: number; completed: number } | null>(null);

    const clearSelection = useCallback(() => {
        setSelectedIndices(new Set());
    }, []);

    const onRowClick = useCallback(
        (idx: number, e: React.MouseEvent) => {
            if (e.shiftKey) {
                const anchor = anchorIndexRef.current;
                if (anchor === null) {
                    anchorIndexRef.current = idx;
                    setFocusIndex(idx);
                    return;
                }
                const rangeStart = Math.min(anchor, idx);
                const rangeEnd = Math.max(anchor, idx);
                const newSelection = new Set<number>();
                for (let i = rangeStart; i <= rangeEnd; i++) {
                    newSelection.add(i);
                }
                setSelectedIndices(newSelection);
                setFocusIndex(idx);
            } else if (e.ctrlKey || e.metaKey) {
                setSelectedIndices((prev) => {
                    const newSet = new Set(prev);
                    if (newSet.has(idx)) {
                        newSet.delete(idx);
                    } else {
                        newSet.add(idx);
                        anchorIndexRef.current = idx;
                    }
                    return newSet;
                });
                setFocusIndex(idx);
            } else {
                anchorIndexRef.current = idx;
                setSelectedIndices(new Set([idx]));
                setFocusIndex(idx);
            }
        },
        [setFocusIndex]
    );

    const hasFilesDragged = useCallback((dataTransfer: DataTransfer): boolean => {
        return dataTransfer.types.includes("Files");
    }, []);

    const handleNativeDragOver = useCallback(
        (e: React.DragEvent) => {
            if (!e.dataTransfer || !hasFilesDragged(e.dataTransfer)) {
                return;
            }
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = "copy";
        },
        [hasFilesDragged]
    );

    const handleNativeDragEnter = useCallback(
        (e: React.DragEvent) => {
            if (!e.dataTransfer || !hasFilesDragged(e.dataTransfer)) {
                return;
            }
            e.preventDefault();
            e.stopPropagation();
            setIsNativeDragging(true);
        },
        [hasFilesDragged]
    );

    const handleNativeDragLeave = useCallback(
        (e: React.DragEvent) => {
            if (!e.dataTransfer || !hasFilesDragged(e.dataTransfer)) {
                return;
            }
            e.preventDefault();
            setIsNativeDragging(false);
        },
        [hasFilesDragged]
    );

    const bumpProgress = useCallback(() => {
        setUploadProgress((prev) => {
            const next = {
                total: (prev?.total ?? 0) + 1,
                completed: (prev?.completed ?? 0) + 1,
            };
            console.log("[DROP-UPLOAD] progress", JSON.stringify(next));
            return next;
        });
    }, []);

    const throttledRefresh = useMemo(() => debounce(500, () => model.refreshCallback()), [model.refreshCallback]);

    const uploadFile = useCallback(
        async (file: File, destUri: string) => {
            const fileName = file.name;
            const filePath = `${destUri}/${fileName}`;
            console.log("[DROP-UPLOAD] uploadFile start:", filePath, "size:", file.size);
            const localPath = env.electron.getPathForFile(file);
            if (localPath) {
                const localUri = formatRemoteUri(localPath, "local");
                const timeoutMs = Math.ceil(Math.max(60000, file.size / 1024 * 200));
                await env.rpc.FileCopyCommand(
                    TabRpcClient,
                    {
                        srcuri: localUri,
                        desturi: filePath,
                        opts: { timeout: timeoutMs },
                    },
                    { timeout: timeoutMs }
                );
                console.log("[DROP-UPLOAD] uploadFile (FileCopy) done:", filePath);
                return;
            }
            try {
                const arrayBuffer = await file.arrayBuffer();
                const uint8Array = new Uint8Array(arrayBuffer);
                const base64Encoded = arrayToBase64(uint8Array);
                await env.rpc.FileWriteCommand(
                    TabRpcClient,
                    {
                        info: { path: filePath },
                        data64: base64Encoded,
                    },
                    { timeout: 60000 }
                );
                console.log("[DROP-UPLOAD] uploadFile (FileWrite) done:", filePath);
            } catch (err) {
                console.warn("[DROP-UPLOAD] uploadFile failed:", filePath, err);
                setErrorMsg({
                    status: "Upload Failed",
                    text: `${err}`,
                    level: "error",
                });
            }
        },
        [env.rpc.FileCopyCommand, env.rpc.FileWriteCommand, env.electron]
    );

    const getFileFromEntry = useCallback(
        (fileEntry: FileSystemFileEntry): Promise<File> => {
            console.log("[DROP-UPLOAD] getFileFromEntry:", fileEntry.name);
            return new Promise<File>((resolve, reject) => {
                fileEntry.file(resolve, reject);
            });
        },
        []
    );

    const uploadDirRecursive = useCallback(
        async (dirEntry: FileSystemDirectoryEntry, destUri: string, depth: number = 0) => {
            console.log("[DROP-UPLOAD] uploadDir start:", dirEntry.name, "depth:", depth);
            if (depth > 20) {
                console.warn("[DROP-UPLOAD] Max directory depth exceeded:", destUri + "/" + dirEntry.name);
                return;
            }
            const newDestUri = `${destUri}/${dirEntry.name}`;
            try {
                await env.rpc.FileMkdirCommand(TabRpcClient, { info: { path: newDestUri } }, null);
                console.log("[DROP-UPLOAD] mkdir done:", newDestUri);
            } catch (err) {
                console.warn("[DROP-UPLOAD] mkdir failed:", newDestUri, err);
                return;
            }
            const reader = dirEntry.createReader();
            const entries: FileSystemEntry[] = [];
            await new Promise<void>((resolve) => {
                const readBatch = () => {
                    reader.readEntries((items) => {
                        if (items.length === 0) {
                            resolve();
                            return;
                        }
                        entries.push(...items);
                        readBatch();
                    });
                };
                readBatch();
            });
            console.log("[DROP-UPLOAD] readEntries done:", dirEntry.name, "count:", entries.length);
            let fileIdx = 0;
            for (const entry of entries) {
                if (entry.isDirectory) {
                    await uploadDirRecursive(entry as FileSystemDirectoryEntry, newDestUri, depth + 1);
                } else if (entry.isFile) {
                    fileIdx++;
                    const fileEntry = entry as FileSystemFileEntry;
                    try {
                        const file = await getFileFromEntry(fileEntry);
                        await uploadFile(file, newDestUri);
                        bumpProgress();
                        throttledRefresh();
                        console.log("[DROP-UPLOAD] file done:", newDestUri + "/" + fileEntry.name, "idx:", fileIdx);
                    } catch (err) {
                        console.warn("[DROP-UPLOAD] file failed:", newDestUri + "/" + fileEntry.name, err);
                        bumpProgress();
                    }
                }
            }
            console.log("[DROP-UPLOAD] uploadDir end:", dirEntry.name, "files:", fileIdx);
        },
        [env.rpc.FileMkdirCommand, uploadFile, getFileFromEntry, bumpProgress, throttledRefresh]
    );

    const collectDropItems = useCallback(
        async (dataTransfer: DataTransfer): Promise<Array<{ file: File } | { dirEntry: FileSystemDirectoryEntry }>> => {
            const items: Array<{ file: File } | { dirEntry: FileSystemDirectoryEntry }> = [];
            console.log("[DROP-UPLOAD] collectDropItems: items.length:", dataTransfer.items.length, "files.length:", dataTransfer.files.length);
            for (let i = 0; i < dataTransfer.items.length; i++) {
                const entry = dataTransfer.items[i].webkitGetAsEntry();
                const fallbackFile = dataTransfer.files[i];
                if (!entry) {
                    console.log("[DROP-UPLOAD] item[", i, "] no entry -> file:", fallbackFile?.name ?? "null", "size:", fallbackFile?.size ?? 0);
                    if (fallbackFile) {
                        items.push({ file: fallbackFile });
                    }
                    continue;
                }
                if (entry.isDirectory) {
                    console.log("[DROP-UPLOAD] item[", i, "] dir:", entry.name);
                    items.push({ dirEntry: entry as FileSystemDirectoryEntry });
                } else if (entry.isFile) {
                    const fileEntry = entry as FileSystemFileEntry;
                    console.log("[DROP-UPLOAD] item[", i, "] file entry:", entry.name);
                    try {
                        const file = await getFileFromEntry(fileEntry);
                        items.push({ file });
                    } catch (err) {
                        console.warn("[DROP-UPLOAD] getFileFromEntry failed for:", entry.name, "falling back to files[i]");
                        if (fallbackFile) {
                            items.push({ file: fallbackFile });
                        }
                    }
                } else {
                    console.log("[DROP-UPLOAD] item[", i, "] unknown entry type, falling back to file:", fallbackFile?.name ?? "null");
                    if (fallbackFile) {
                        items.push({ file: fallbackFile });
                    }
                }
            }
            console.log("[DROP-UPLOAD] collectDropItems done, count:", items.length, "of", dataTransfer.items.length);
            return items;
        },
        [getFileFromEntry]
    );

    const processDropUpload = useCallback(
        async (destUri: string, dropItems: Array<{ file: File } | { dirEntry: FileSystemDirectoryEntry }>) => {
            console.log("[DROP-UPLOAD] processDropUpload start, destUri:", destUri, "itemCount:", dropItems.length);
            setUploadProgress({ total: 0, completed: 0 });
            let itemIdx = 0;
            for (const item of dropItems) {
                itemIdx++;
                if ("dirEntry" in item) {
                    console.log("[DROP-UPLOAD] processing dir item[", itemIdx, "]:", item.dirEntry.name);
                    await uploadDirRecursive(item.dirEntry, destUri);
                    console.log("[DROP-UPLOAD] dir item done:", item.dirEntry.name);
                } else {
                    console.log("[DROP-UPLOAD] processing file item[", itemIdx, "]:", item.file.name);
                    await uploadFile(item.file, destUri);
                    bumpProgress();
                    throttledRefresh();
                    console.log("[DROP-UPLOAD] file item done:", item.file.name);
                }
            }
            console.log("[DROP-UPLOAD] processDropUpload done, clearing progress");
            setUploadProgress(null);
            throttledRefresh();
        },
        [uploadFile, uploadDirRecursive, bumpProgress, throttledRefresh]
    );

    const handleNativeDrop = useCallback(
        (e: React.DragEvent) => {
            setIsNativeDragging(false);
            if (!e.dataTransfer || e.dataTransfer.files.length === 0) {
                return;
            }
            e.preventDefault();
            e.stopPropagation();
            const destUri = model.formatRemoteUri(dirPath, globalStore.get);
            console.log("[DROP-UPLOAD] handleNativeDrop: files.length:", e.dataTransfer.files.length, "items.length:", e.dataTransfer.items.length);
            fireAndForget(async () => {
                try {
                    const resolvedDestUri = await destUri;
                    console.log("[DROP-UPLOAD] resolvedDestUri:", resolvedDestUri);
                    const dropItems = await collectDropItems(e.dataTransfer);
                    await processDropUpload(resolvedDestUri, dropItems);
                    console.log("[DROP-UPLOAD] ALL DONE");
                } catch (err) {
                    console.warn("[DROP-UPLOAD] fatal error:", err);
                    setUploadProgress(null);
                    setErrorMsg({
                        status: "Upload Failed",
                        text: `${err}`,
                        level: "error",
                    });
                }
            });
        },
        [dirPath, model.formatRemoteUri, collectDropItems, processDropUpload]
    );

    useEffect(() => {
        model.refreshCallback = () => {
            setRefreshVersion((refreshVersion) => refreshVersion + 1);
        };
        return () => {
            model.refreshCallback = null;
        };
    }, [setRefreshVersion]);

    useEffect(
        () =>
            fireAndForget(async () => {
                const entries: FileInfo[] = [];
                try {
                    const remotePath = await model.formatRemoteUri(dirPath, globalStore.get);
                    const stream = env.rpc.FileListStreamCommand(TabRpcClient, { path: remotePath }, null);
                    for await (const chunk of stream) {
                        if (chunk?.fileinfo) {
                            entries.push(...chunk.fileinfo);
                        }
                    }
                    if (finfo?.dir && finfo?.path !== finfo?.dir) {
                        entries.unshift({
                            name: "..",
                            path: finfo.dir,
                            isdir: true,
                            modtime: new Date().getTime(),
                            mimetype: "directory",
                        });
                    }
                } catch (e) {
                    console.error("Directory Read Error", e);
                    setErrorMsg({
                        status: "Cannot Read Directory",
                        text: `${e}`,
                    });
                }
                setUnfilteredData(entries);
            }),
        [conn, dirPath, refreshVersion]
    );

    const filteredData = useMemo(
        () =>
            unfilteredData?.filter((fileInfo) => {
                if (fileInfo.name == null) {
                    console.log("fileInfo.name is null", fileInfo);
                    return false;
                }
                if (!showHiddenFiles && fileInfo.name.startsWith(".") && fileInfo.name != "..") {
                    return false;
                }
                return fileInfo.name.toLowerCase().includes(searchText);
            }) ?? [],
        [unfilteredData, showHiddenFiles, searchText]
    );

    useEffect(() => {
        model.directoryKeyDownHandler = (waveEvent: WaveKeyboardEvent): boolean => {
            if (checkKeyPressed(waveEvent, "Cmd:f")) {
                globalStore.set(model.directorySearchActive, true);
                return true;
            }
            if (checkKeyPressed(waveEvent, "Escape")) {
                setSearchText("");
                globalStore.set(model.directorySearchActive, false);
                return;
            }
            if (checkKeyPressed(waveEvent, "ArrowUp")) {
                setFocusIndex((idx) => Math.max(idx - 1, 0));
                return true;
            }
            if (checkKeyPressed(waveEvent, "ArrowDown")) {
                setFocusIndex((idx) => Math.min(idx + 1, filteredData.length - 1));
                return true;
            }
            if (checkKeyPressed(waveEvent, "PageUp")) {
                setFocusIndex((idx) => Math.max(idx - PageJumpSize, 0));
                return true;
            }
            if (checkKeyPressed(waveEvent, "PageDown")) {
                setFocusIndex((idx) => Math.min(idx + PageJumpSize, filteredData.length - 1));
                return true;
            }
            if (checkKeyPressed(waveEvent, "Enter")) {
                if (filteredData.length == 0) {
                    return;
                }
                model.goHistory(selectedPath);
                setSearchText("");
                globalStore.set(model.directorySearchActive, false);
                return true;
            }
            if (checkKeyPressed(waveEvent, "Backspace")) {
                if (searchText.length == 0) {
                    return true;
                }
                setSearchText((current) => current.slice(0, -1));
                return true;
            }
            if (
                checkKeyPressed(waveEvent, "Space") &&
                searchText == "" &&
                PLATFORM == PlatformMacOS &&
                !blockData?.meta?.connection
            ) {
                env.electron.onQuicklook(selectedPath);
                return true;
            }
            if (isCharacterKeyEvent(waveEvent)) {
                setSearchText((current) => current + waveEvent.key);
                return true;
            }
            return false;
        };
        return () => {
            model.directoryKeyDownHandler = null;
        };
    }, [filteredData, selectedPath, searchText]);

    useEffect(() => {
        if (filteredData.length != 0 && focusIndex > filteredData.length - 1) {
            setFocusIndex(filteredData.length - 1);
        }
    }, [filteredData]);

    const entryManagerPropsAtom = useState(
        atom<EntryManagerOverlayProps>(null) as PrimitiveAtom<EntryManagerOverlayProps>
    )[0];
    const [entryManagerProps, setEntryManagerProps] = useAtom(entryManagerPropsAtom);

    const { refs, floatingStyles, context } = useFloating({
        open: !!entryManagerProps,
        onOpenChange: () => setEntryManagerProps(undefined),
        middleware: [offset(({ rects }) => -rects.reference.height / 2 - rects.floating.height / 2)],
    });

    const handleDropCopy = useCallback(
        async (data: CommandFileCopyData, isDir: boolean) => {
            try {
                await env.rpc.FileCopyCommand(TabRpcClient, data, { timeout: data.opts.timeout });
            } catch (e) {
                console.warn("Copy failed:", e);
                const copyError = `${e}`;
                const allowRetry = copyError.includes(overwriteError) || copyError.includes(mergeError);
                let errorMsg: ErrorMsg;
                if (allowRetry) {
                    errorMsg = {
                        status: "Confirm Overwrite File(s)",
                        text: "This copy operation will overwrite an existing file. Would you like to continue?",
                        level: "warning",
                        buttons: [
                            {
                                text: "Delete Then Copy",
                                onClick: async () => {
                                    data.opts.overwrite = true;
                                    await handleDropCopy(data, isDir);
                                },
                            },
                            {
                                text: "Sync",
                                onClick: async () => {
                                    data.opts.merge = true;
                                    await handleDropCopy(data, isDir);
                                },
                            },
                        ],
                    };
                } else {
                    errorMsg = {
                        status: "Copy Failed",
                        text: copyError,
                        level: "error",
                    };
                }
                setErrorMsg(errorMsg);
            }
            model.refreshCallback();
        },
        [model.refreshCallback]
    );

    const [, drop] = useDrop(
        () => ({
            accept: "FILE_ITEM", //a name of file drop type
            canDrop: (_, monitor) => {
                const dragItem = monitor.getItem<DraggedFile>();
                // drop if not current dir is the parent directory of the dragged item
                // requires absolute path
                if (monitor.isOver({ shallow: false }) && dragItem.absParent !== dirPath) {
                    return true;
                }
                return false;
            },
            drop: async (draggedFile: DraggedFile, monitor) => {
                if (!monitor.didDrop()) {
                    const timeoutYear = 31536000000; // one year
                    const opts: FileCopyOpts = {
                        timeout: timeoutYear,
                    };
                    const desturi = await model.formatRemoteUri(dirPath, globalStore.get);
                    const data: CommandFileCopyData = {
                        srcuri: draggedFile.uri,
                        desturi,
                        opts,
                    };
                    await handleDropCopy(data, draggedFile.isDir);
                }
            },
            // TODO: mabe add a hover option?
        }),
        [dirPath, model.formatRemoteUri, model.refreshCallback]
    );

    useEffect(() => {
        drop(refs.reference);
    }, [refs.reference]);

    const dismiss = useDismiss(context);
    const { getReferenceProps, getFloatingProps } = useInteractions([dismiss]);

    const newFile = useCallback(() => {
        setEntryManagerProps({
            entryManagerType: EntryManagerType.NewFile,
            onSave: (newName: string) => {
                console.log(`newFile: ${newName}`);
                fireAndForget(async () => {
                    await env.rpc.FileCreateCommand(
                        TabRpcClient,
                        {
                            info: {
                                path: await model.formatRemoteUri(`${dirPath}/${newName}`, globalStore.get),
                            },
                        },
                        null
                    );
                    model.refreshCallback();
                });
                setEntryManagerProps(undefined);
            },
        });
    }, [dirPath]);
    const newDirectory = useCallback(() => {
        setEntryManagerProps({
            entryManagerType: EntryManagerType.NewDirectory,
            onSave: (newName: string) => {
                console.log(`newDirectory: ${newName}`);
                fireAndForget(async () => {
                    await env.rpc.FileMkdirCommand(TabRpcClient, {
                        info: {
                            path: await model.formatRemoteUri(`${dirPath}/${newName}`, globalStore.get),
                        },
                    });
                    model.refreshCallback();
                });
                setEntryManagerProps(undefined);
            },
        });
    }, [dirPath]);

    const handleFileContextMenu = useCallback(
        (e: any) => {
            e.preventDefault();
            e.stopPropagation();
            const menu: ContextMenuItem[] = [
                {
                    label: "New File",
                    click: () => {
                        newFile();
                    },
                },
                {
                    label: "New Folder",
                    click: () => {
                        newDirectory();
                    },
                },
                {
                    type: "separator",
                },
            ];
            addOpenMenuItems(menu, conn, finfo);

            ContextMenuModel.getInstance().showContextMenu(menu, e);
        },
        [setRefreshVersion, conn, newFile, newDirectory, dirPath]
    );

    return (
        <Fragment>
            <div
                ref={refs.setReference}
                className={clsx("dir-table-container", { "dir-table-native-dragging": isNativeDragging })}
                onChangeCapture={(e) => {
                    const event = e as React.ChangeEvent<HTMLInputElement>;
                    if (!entryManagerProps) {
                        setSearchText(event.target.value.toLowerCase());
                    }
                }}
                {...getReferenceProps()}
                onContextMenu={(e) => handleFileContextMenu(e)}
                onClick={() => {
                    setEntryManagerProps(undefined);
                    clearSelection();
                }}
                onDragOver={handleNativeDragOver}
                onDragEnter={handleNativeDragEnter}
                onDragLeave={handleNativeDragLeave}
                onDrop={handleNativeDrop}
            >
                <DirectoryTable
                    model={model}
                    data={filteredData}
                    search={searchText}
                    focusIndex={focusIndex}
                    setSearch={setSearchText}
                    setSelectedPath={setSelectedPath}
                    setRefreshVersion={setRefreshVersion}
                    entryManagerOverlayPropsAtom={entryManagerPropsAtom}
                    newFile={newFile}
                    newDirectory={newDirectory}
                    selectedIndices={selectedIndices}
                    onRowClick={onRowClick}
                />
                {uploadProgress && (
                    <div className="dir-upload-progress">
                        <div className="dir-upload-progress-bar" />
                        <span className="dir-upload-progress-text">
                            Uploaded {uploadProgress.completed} file{uploadProgress.completed !== 1 ? "s" : ""}...
                        </span>
                    </div>
                )}
            </div>
            {entryManagerProps && (
                <EntryManagerOverlay
                    {...entryManagerProps}
                    forwardRef={refs.setFloating}
                    style={floatingStyles}
                    getReferenceProps={getFloatingProps}
                    onCancel={() => setEntryManagerProps(undefined)}
                />
            )}
        </Fragment>
    );
}

export { DirectoryPreview };
