// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package aiusechat

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/aiusechat/uctypes"
	"github.com/wavetermdev/waveterm/pkg/blockcontroller"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

type TermGetScrollbackToolInput struct {
	WidgetId  string `json:"widget_id"`
	LineStart int    `json:"line_start,omitempty"`
	Count     int    `json:"count,omitempty"`
}

type CommandInfo struct {
	Command  string `json:"command"`
	Status   string `json:"status"`
	ExitCode *int   `json:"exitcode,omitempty"`
}

type TermGetScrollbackToolOutput struct {
	TotalLines         int          `json:"totallines"`
	LineStart          int          `json:"linestart"`
	LineEnd            int          `json:"lineend"`
	ReturnedLines      int          `json:"returnedlines"`
	Content            string       `json:"content"`
	SinceLastOutputSec *int         `json:"sincelastoutputsec,omitempty"`
	HasMore            bool         `json:"hasmore"`
	NextStart          *int         `json:"nextstart"`
	LastCommand        *CommandInfo `json:"lastcommand,omitempty"`
}

func parseTermGetScrollbackInput(input any) (*TermGetScrollbackToolInput, error) {
	const (
		DefaultCount = 200
		MaxCount     = 1000
	)

	result := &TermGetScrollbackToolInput{
		LineStart: 0,
		Count:     0,
	}

	if input == nil {
		result.Count = DefaultCount
		return result, nil
	}

	inputBytes, err := json.Marshal(input)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal input: %w", err)
	}

	if err := json.Unmarshal(inputBytes, result); err != nil {
		return nil, fmt.Errorf("failed to unmarshal input: %w", err)
	}

	if result.Count == 0 {
		result.Count = DefaultCount
	}

	if result.Count < 0 {
		return nil, fmt.Errorf("count must be positive")
	}

	result.Count = min(result.Count, MaxCount)

	return result, nil
}

func getTermScrollbackOutput(tabId string, widgetId string, rpcData wshrpc.CommandTermGetScrollbackLinesData) (*TermGetScrollbackToolOutput, error) {
	ctx, cancelFn := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelFn()

	fullBlockId, err := wcore.ResolveBlockIdFromPrefix(ctx, tabId, widgetId)
	if err != nil {
		return nil, err
	}

	rpcClient := wshclient.GetBareRpcClient()
	result, err := wshclient.TermGetScrollbackLinesCommand(
		rpcClient,
		rpcData,
		&wshrpc.RpcOpts{Route: wshutil.MakeFeBlockRouteId(fullBlockId)},
	)
	if err != nil {
		return nil, err
	}

	content := strings.Join(result.Lines, "\n")
	var effectiveLineEnd int
	if rpcData.LastCommand {
		effectiveLineEnd = result.LineStart + len(result.Lines)
	} else {
		effectiveLineEnd = min(rpcData.LineEnd, result.TotalLines)
	}
	hasMore := effectiveLineEnd < result.TotalLines

	var sinceLastOutputSec *int
	if result.LastUpdated > 0 {
		sec := max(0, int((time.Now().UnixMilli()-result.LastUpdated)/1000))
		sinceLastOutputSec = &sec
	}

	var nextStart *int
	if hasMore {
		nextStart = &effectiveLineEnd
	}

	blockORef := waveobj.MakeORef(waveobj.OType_Block, fullBlockId)
	rtInfo := wstore.GetRTInfo(blockORef)

	var lastCommand *CommandInfo
	if rtInfo != nil && rtInfo.ShellIntegration && rtInfo.ShellLastCmd != "" {
		cmdInfo := &CommandInfo{
			Command: rtInfo.ShellLastCmd,
		}
		if rtInfo.ShellState == "running-command" {
			cmdInfo.Status = "running"
		} else if rtInfo.ShellState == "ready" {
			cmdInfo.Status = "completed"
			exitCode := rtInfo.ShellLastCmdExitCode
			cmdInfo.ExitCode = &exitCode
		}
		lastCommand = cmdInfo
	}

	return &TermGetScrollbackToolOutput{
		TotalLines:         result.TotalLines,
		LineStart:          result.LineStart,
		LineEnd:            effectiveLineEnd,
		ReturnedLines:      len(result.Lines),
		Content:            content,
		SinceLastOutputSec: sinceLastOutputSec,
		HasMore:            hasMore,
		NextStart:          nextStart,
		LastCommand:        lastCommand,
	}, nil
}

func GetTermGetScrollbackToolDefinition(tabId string) uctypes.ToolDefinition {
	return uctypes.ToolDefinition{
		Name:        "term_get_scrollback",
		DisplayName: "Get Terminal Scrollback",
		Description: "Fetch terminal scrollback from a widget as plain text. Index 0 is the most recent line; indices increase going upward (older lines). Also returns last command and exit code if shell integration is enabled.",
		ToolLogName: "term:getscrollback",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"widget_id": map[string]any{
					"type":        "string",
					"description": "8-character widget ID of the terminal widget",
				},
				"line_start": map[string]any{
					"type":        "integer",
					"minimum":     0,
					"description": "Logical start index where 0 = most recent line (default: 0).",
				},
				"count": map[string]any{
					"type":        "integer",
					"minimum":     1,
					"description": "Number of lines to return from line_start (default: 200).",
				},
			},
			"required":             []string{"widget_id"},
			"additionalProperties": false,
		},
		ToolCallDesc: func(input any, output any, toolUseData *uctypes.UIMessageDataToolUse) string {
			parsed, err := parseTermGetScrollbackInput(input)
			if err != nil {
				return fmt.Sprintf("error parsing input: %v", err)
			}

			if parsed.LineStart == 0 && parsed.Count == 200 {
				return fmt.Sprintf("reading terminal output from %s (most recent %d lines)", parsed.WidgetId, parsed.Count)
			}
			lineEnd := parsed.LineStart + parsed.Count
			return fmt.Sprintf("reading terminal output from %s (lines %d-%d)", parsed.WidgetId, parsed.LineStart, lineEnd)
		},
		ToolAnyCallback: func(input any, toolUseData *uctypes.UIMessageDataToolUse) (any, error) {
			parsed, err := parseTermGetScrollbackInput(input)
			if err != nil {
				return nil, err
			}

			lineEnd := parsed.LineStart + parsed.Count
			output, err := getTermScrollbackOutput(
				tabId,
				parsed.WidgetId,
				wshrpc.CommandTermGetScrollbackLinesData{
					LineStart:   parsed.LineStart,
					LineEnd:     lineEnd,
					LastCommand: false,
				},
			)
			if err != nil {
				return nil, fmt.Errorf("failed to get terminal scrollback: %w", err)
			}
			return output, nil
		},
	}
}

type TermCommandOutputToolInput struct {
	WidgetId string `json:"widget_id"`
}

func parseTermCommandOutputInput(input any) (*TermCommandOutputToolInput, error) {
	result := &TermCommandOutputToolInput{}

	if input == nil {
		return nil, fmt.Errorf("widget_id is required")
	}

	inputBytes, err := json.Marshal(input)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal input: %w", err)
	}

	if err := json.Unmarshal(inputBytes, result); err != nil {
		return nil, fmt.Errorf("failed to unmarshal input: %w", err)
	}

	if result.WidgetId == "" {
		return nil, fmt.Errorf("widget_id is required")
	}

	return result, nil
}

func GetTermCommandOutputToolDefinition(tabId string) uctypes.ToolDefinition {
	return uctypes.ToolDefinition{
		Name:        "term_command_output",
		DisplayName: "Get Last Command Output",
		Description: "Retrieve output from the most recent command in a terminal widget. Requires shell integration to be enabled. Returns the command text, exit code, and up to 1000 lines of output.",
		ToolLogName: "term:commandoutput",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"widget_id": map[string]any{
					"type":        "string",
					"description": "8-character widget ID of the terminal widget",
				},
			},
			"required":             []string{"widget_id"},
			"additionalProperties": false,
		},
		ToolCallDesc: func(input any, output any, toolUseData *uctypes.UIMessageDataToolUse) string {
			parsed, err := parseTermCommandOutputInput(input)
			if err != nil {
				return fmt.Sprintf("error parsing input: %v", err)
			}
			return fmt.Sprintf("reading last command output from %s", parsed.WidgetId)
		},
		ToolAnyCallback: func(input any, toolUseData *uctypes.UIMessageDataToolUse) (any, error) {
			parsed, err := parseTermCommandOutputInput(input)
			if err != nil {
				return nil, err
			}

			ctx, cancelFn := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancelFn()

			fullBlockId, err := wcore.ResolveBlockIdFromPrefix(ctx, tabId, parsed.WidgetId)
			if err != nil {
				return nil, err
			}

			blockORef := waveobj.MakeORef(waveobj.OType_Block, fullBlockId)
			rtInfo := wstore.GetRTInfo(blockORef)
			if rtInfo == nil || !rtInfo.ShellIntegration {
				return nil, fmt.Errorf("shell integration is not enabled for this terminal")
			}

			output, err := getTermScrollbackOutput(
				tabId,
				parsed.WidgetId,
				wshrpc.CommandTermGetScrollbackLinesData{
					LastCommand: true,
				},
			)
			if err != nil {
				return nil, fmt.Errorf("failed to get command output: %w", err)
			}
			return output, nil
		},
	}
}

type TermRunCommandToolInput struct {
	WidgetId string `json:"widget_id"`
	Command  string `json:"command"`
}

func parseTermRunCommandInput(input any) (*TermRunCommandToolInput, error) {
	result := &TermRunCommandToolInput{}
	if input == nil {
		return nil, fmt.Errorf("missing input parameters")
	}

	inputBytes, err := json.Marshal(input)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal input: %w", err)
	}

	if err := json.Unmarshal(inputBytes, result); err != nil {
		return nil, fmt.Errorf("failed to unmarshal input: %w", err)
	}

	if result.WidgetId == "" {
		return nil, fmt.Errorf("missing widget_id parameter")
	}
	if result.Command == "" {
		return nil, fmt.Errorf("missing command parameter")
	}

	return result, nil
}

func IsQueryCommand(cmd string) bool {
	cmd = strings.TrimSpace(cmd)
	if cmd == "" {
		return true
	}

	// 1. Remove safe redirections
	temp := cmd
	temp = strings.ReplaceAll(temp, "2>&1", " ")
	temp = strings.ReplaceAll(temp, "2>/dev/null", " ")
	temp = strings.ReplaceAll(temp, "1>/dev/null", " ")
	temp = strings.ReplaceAll(temp, ">/dev/null", " ")
	temp = strings.ReplaceAll(temp, "> /dev/null", " ")
	temp = strings.ReplaceAll(temp, "2> /dev/null", " ")

	// 2. Replace pipeline operators so they don't trigger the dangerous character check (like single &)
	temp = strings.ReplaceAll(temp, "&&", "|")
	temp = strings.ReplaceAll(temp, "||", "|")

	// 3. Check for dangerous shell operators or remaining redirections
	if strings.ContainsAny(temp, "<>&$\n`\r") {
		return false
	}

	// 4. Split by pipe '|' and semicolon ';' to validate each command in the chain
	parts := strings.Split(temp, "|")
	for _, part := range parts {
		subParts := strings.Split(part, ";")
		for _, subPart := range subParts {
			subPart = strings.TrimSpace(subPart)
			if subPart == "" {
				continue
			}

			words := strings.Fields(subPart)
			if len(words) == 0 {
				continue
			}
			firstWord := words[0]

			// List of safe query-only commands
			safeCommands := map[string]bool{
				"ls":       true,
				"pwd":      true,
				"du":       true,
				"df":       true,
				"cat":      true,
				"grep":     true,
				"egrep":    true,
				"fgrep":    true,
				"find":     true,
				"env":      true,
				"whoami":   true,
				"id":       true,
				"uname":    true,
				"hostname": true,
				"ps":       true,
				"top":      true,
				"free":     true,
				"uptime":   true,
				"echo":     true,
				"head":     true,
				"tail":     true,
				"wc":       true,
				"file":     true,
				"which":    true,
				"type":     true,
				"git":      true,
				"sort":     true,
				"uniq":     true,
				"cut":      true,
				"jq":       true,
				"xxd":      true,
				"od":       true,
				"hexdump":  true,
				"less":     true,
				"more":     true,
				"awk":      true,
			}

			if !safeCommands[firstWord] {
				return false
			}

			// Special check for git: only allow safe subcommands
			if firstWord == "git" {
				if len(words) < 2 {
					return true
				}
				subCmd := words[1]
				safeGitSubCmds := map[string]bool{
					"status": true,
					"diff":   true,
					"log":    true,
					"show":   true,
					"branch": true,
					"tag":    true,
				}
				if !safeGitSubCmds[subCmd] {
					return false
				}
			}
		}
	}

	return true
}

func GetTermRunCommandToolDefinition(tabId string) uctypes.ToolDefinition {
	return uctypes.ToolDefinition{
		Name:        "term_run_command",
		DisplayName: "Run Terminal Command",
		Description: "Run a shell command in the specified terminal widget and wait for it to complete. Returns the output of the command.",
		ToolLogName: "term:runcommand",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"widget_id": map[string]any{
					"type":        "string",
					"description": "8-character widget ID of the terminal widget (e.g., from tab state Open Widgets)",
				},
				"command": map[string]any{
					"type":        "string",
					"description": "The shell command to execute in the terminal",
				},
			},
			"required":             []string{"widget_id", "command"},
			"additionalProperties": false,
		},
		ToolCallDesc: func(input any, output any, toolUseData *uctypes.UIMessageDataToolUse) string {
			parsed, err := parseTermRunCommandInput(input)
			if err != nil {
				return fmt.Sprintf("error parsing input: %v", err)
			}
			return fmt.Sprintf("running command %q in terminal %s", parsed.Command, parsed.WidgetId)
		},
		ToolApproval: func(input any) string {
			parsed, err := parseTermRunCommandInput(input)
			if err != nil {
				return uctypes.ApprovalNeedsApproval
			}
			if IsQueryCommand(parsed.Command) {
				return uctypes.ApprovalAutoApproved
			}
			return uctypes.ApprovalNeedsApproval
		},
		ToolAnyCallback: func(input any, toolUseData *uctypes.UIMessageDataToolUse) (any, error) {
			parsed, err := parseTermRunCommandInput(input)
			if err != nil {
				return nil, err
			}

			ctx, cancelFn := context.WithTimeout(context.Background(), 2*time.Minute)
			defer cancelFn()

			fullBlockId, err := wcore.ResolveBlockIdFromPrefix(ctx, tabId, parsed.WidgetId)
			if err != nil {
				return nil, fmt.Errorf("failed to resolve terminal block: %w", err)
			}

			status := blockcontroller.GetBlockControllerRuntimeStatus(fullBlockId)
			if status == nil {
				return nil, fmt.Errorf("no runtime status found for terminal block")
			}
			if status.ShellProcStatus != blockcontroller.Status_Running {
				return nil, fmt.Errorf("terminal block shell is not running (status: %s)", status.ShellProcStatus)
			}

			blockORef := waveobj.MakeORef(waveobj.OType_Block, fullBlockId)
			rtInfo := wstore.GetRTInfo(blockORef)
			if rtInfo != nil && rtInfo.ShellState == "running-command" {
				return nil, fmt.Errorf("terminal is busy running another command")
			}

			// Send the input to the block
			inputUnion := &blockcontroller.BlockInputUnion{
				InputData: []byte(parsed.Command + "\n"),
			}
			err = blockcontroller.SendInput(fullBlockId, inputUnion)
			if err != nil {
				return nil, fmt.Errorf("failed to send command to terminal: %w", err)
			}

			// Wait for the command execution to start and then finish
			ticker := time.NewTicker(200 * time.Millisecond)
			defer ticker.Stop()
			timeout := time.After(60 * time.Second)

			if rtInfo != nil && rtInfo.ShellIntegration {
				oldCmd := rtInfo.ShellLastCmd

				// 1. Wait for command to start (or timeout after 2 seconds)
				startTimeout := time.After(2 * time.Second)
				started := false
				for !started {
					select {
					case <-ctx.Done():
						return nil, ctx.Err()
					case <-startTimeout:
						started = true
					case <-ticker.C:
						rt := wstore.GetRTInfo(blockORef)
						if rt != nil {
							if rt.ShellState == "running-command" || rt.ShellLastCmd != oldCmd {
								started = true
							}
						}
					}
				}

				// 2. Wait for command to complete (ShellState becomes ready)
				for {
					select {
					case <-ctx.Done():
						return nil, ctx.Err()
					case <-timeout:
						return nil, fmt.Errorf("timeout waiting for command to complete execution")
					case <-ticker.C:
						rt := wstore.GetRTInfo(blockORef)
						if rt != nil {
							if rt.ShellState == "ready" {
								goto cmd_completed
							}
						}
					}
				}
			} else {
				// No shell integration: sleep for 2 seconds to let the command run, then return
				select {
				case <-ctx.Done():
					return nil, ctx.Err()
				case <-time.After(2 * time.Second):
					goto cmd_completed
				}
			}

		cmd_completed:
			// Retrieve the output of the command
			output, err := getTermScrollbackOutput(
				tabId,
				parsed.WidgetId,
				wshrpc.CommandTermGetScrollbackLinesData{
					LastCommand: true,
				},
			)
			if err != nil {
				return nil, fmt.Errorf("failed to get command output: %w", err)
			}

			return output, nil
		},
	}
}
