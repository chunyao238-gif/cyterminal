// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import React, { useState, useEffect, useRef } from "react";
import { useAtom } from "jotai";
import clsx from "clsx";
import { getCommandHistory } from "./term-history";
import { TermViewModel } from "./term-model";

interface TermHistoryPopupProps {
    blockId: string;
    model: TermViewModel;
}

export const TermHistoryPopup = ({ blockId, model }: TermHistoryPopupProps) => {
    const [isOpen, setIsOpen] = useAtom(model.termHistoryOpenAtom);
    const [filter, setFilter] = useState("");
    const [selectedIndex, setSelectedIndex] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLDivElement>(null);

    // Fetch history (latest first)
    const history = React.useMemo(() => {
        return [...getCommandHistory(blockId)].reverse();
    }, [blockId, isOpen]);

    // Filtered history
    const filteredHistory = React.useMemo(() => {
        if (!filter) return history;
        const lowFilter = filter.toLowerCase();
        return history.filter(cmd => cmd.toLowerCase().includes(lowFilter));
    }, [history, filter]);

    // Reset selection index when filter changes
    useEffect(() => {
        setSelectedIndex(0);
    }, [filter]);

    // Autofocus input when modal opens
    useEffect(() => {
        if (isOpen) {
            setFilter("");
            setSelectedIndex(0);
            setTimeout(() => {
                inputRef.current?.focus();
            }, 50);
        }
    }, [isOpen]);

    // Scroll selected item into view
    useEffect(() => {
        if (listRef.current) {
            const selectedItem = listRef.current.querySelector(".selected-item");
            if (selectedItem) {
                selectedItem.scrollIntoView({ block: "nearest" });
            }
        }
    }, [selectedIndex]);

    if (!isOpen) return null;

    const handleClose = () => {
        setIsOpen(false);
        model.giveFocus();
    };

    const handleSelect = (cmd: string) => {
        model.sendDataToController(cmd);
        handleClose();
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Escape") {
            e.preventDefault();
            handleClose();
        } else if (e.key === "ArrowDown") {
            e.preventDefault();
            setSelectedIndex(prev => (filteredHistory.length > 0 ? (prev + 1) % filteredHistory.length : 0));
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setSelectedIndex(prev => (filteredHistory.length > 0 ? (prev - 1 + filteredHistory.length) % filteredHistory.length : 0));
        } else if (e.key === "Enter") {
            e.preventDefault();
            if (filteredHistory.length > 0 && selectedIndex < filteredHistory.length) {
                handleSelect(filteredHistory[selectedIndex]);
            }
        }
    };

    return (
        <div 
            className="absolute inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[2px]"
            onClick={handleClose}
        >
            <div 
                className="flex flex-col w-[500px] max-h-[350px] bg-[#1e1e1e] border border-[#3e3e3e] rounded-lg shadow-2xl overflow-hidden font-sans text-sm text-[#e0e0e0]"
                onClick={e => e.stopPropagation()}
            >
                {/* Search Header */}
                <div className="flex items-center px-3 py-2 border-b border-[#3e3e3e] bg-[#252526]">
                    <i className="fa fa-search text-[#858585] mr-2" />
                    <input
                        ref={inputRef}
                        type="text"
                        placeholder="Search command history..."
                        value={filter}
                        onChange={e => setFilter(e.target.value)}
                        onKeyDown={handleKeyDown}
                        className="flex-1 bg-transparent border-none outline-none text-[#e0e0e0] placeholder-[#858585] py-1"
                    />
                    <button 
                        onClick={handleClose}
                        className="text-[#858585] hover:text-[#e0e0e0] ml-2 transition-colors"
                    >
                        <i className="fa fa-times" />
                    </button>
                </div>

                {/* History List */}
                <div 
                    ref={listRef}
                    className="flex-1 overflow-y-auto py-1 max-h-[300px] scrollbar-thin scrollbar-thumb-[#3e3e3e]"
                >
                    {filteredHistory.length === 0 ? (
                        <div className="text-center text-[#858585] py-8 select-none">
                            No matching commands
                        </div>
                    ) : (
                        filteredHistory.map((cmd, index) => (
                            <div
                                key={index}
                                onClick={() => handleSelect(cmd)}
                                onMouseEnter={() => setSelectedIndex(index)}
                                className={clsx(
                                    "px-4 py-2 cursor-pointer select-none truncate font-mono text-xs transition-colors",
                                    index === selectedIndex 
                                        ? "bg-[#04395e] text-white selected-item" 
                                        : "hover:bg-[#2a2d2e] text-[#cccccc]"
                                )}
                            >
                                {cmd}
                            </div>
                        ))
                    )}
                </div>

                {/* Status Bar */}
                <div className="px-3 py-1 bg-[#181818] border-t border-[#3e3e3e] text-[10px] text-[#858585] flex justify-between select-none">
                    <span>↑↓ to navigate • Enter to select • Esc to close</span>
                    <span>{filteredHistory.length} items</span>
                </div>
            </div>
        </div>
    );
};
