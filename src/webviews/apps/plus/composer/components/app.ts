import { consume } from '@lit/context';
import { css, html, LitElement } from 'lit';
import { customElement, query, state } from 'lit/decorators.js';
import { when } from 'lit/directives/when.js';
import Sortable from 'sortablejs';
import type { ComposerCommit, ComposerHunk, State } from '../../../../plus/composer/protocol';
import {
	FinishAndCommitCommand,
	GenerateCommitMessageCommand,
	GenerateCommitsCommand,
} from '../../../../plus/composer/protocol';
import { createCombinedDiffForCommit, updateHunkAssignments } from '../../../../plus/composer/utils';
import { ipcContext } from '../../../shared/contexts/ipc';
import type { HostIpc } from '../../../shared/ipc';
import { stateContext } from '../context';
import type { DetailsPanel } from './details-panel';
import '../../../shared/components/button';
import '../../../shared/components/code-icon';
import '../../../shared/components/overlays/tooltip';
import './commit-item';
import './commits-panel';
import './details-panel';
import './hunk-item';

// Internal history management interfaces
interface ComposerDataSnapshot {
	hunks: ComposerHunk[];
	commits: ComposerCommit[];
	selectedCommitId: string | null;
	selectedCommitIds: Set<string>;
	selectedUnassignedSection: string | null;
	selectedHunkIds: Set<string>;
}

interface ComposerHistory {
	resetState: ComposerDataSnapshot | null;
	undoStack: ComposerDataSnapshot[];
	redoStack: ComposerDataSnapshot[];
}

const historyLimit = 3;

@customElement('gl-composer-app')
export class ComposerApp extends LitElement {
	@consume({ context: stateContext, subscribe: true })
	state!: State;

	@consume({ context: ipcContext })
	private _ipc!: HostIpc;

	// Internal history management
	private history: ComposerHistory = {
		resetState: null,
		undoStack: [],
		redoStack: [],
	};

	// Debounce timer for commit message updates
	private commitMessageDebounceTimer?: number;
	private commitMessageBeingEdited: string | null = null; // Track which commit is being edited

	static override styles = css`
		:host {
			display: flex;
			flex-direction: column;
			height: 100vh;
			padding: 1.6rem;
			gap: 1.6rem;
			box-sizing: border-box;
		}

		.header {
			display: flex;
			justify-content: space-between;
			align-items: center;
		}

		.header h1 {
			margin: 0;
			font-size: 2.4rem;
			font-weight: 600;
		}

		.main-content {
			display: flex;
			flex: 1;
			gap: 1.6rem;
			min-height: 0;
		}

		gl-commits-panel {
			flex: none;
			width: clamp(30rem, 28vw, 44rem);
		}

		gl-details-panel {
			flex: 1;
			min-width: 0;
		}

		::backdrop {
			background: rgba(0, 0, 0, 0.5);
		}

		.modal {
			background: var(--vscode-editor-background);
			border: 1px solid var(--vscode-panel-border);
			border-radius: 8px;
			padding: 2.4rem;
			min-width: 300px;
			text-align: center;
		}

		.modal h2 {
			margin: 0 0 1.6rem 0;
			color: var(--vscode-foreground);
		}

		.modal p {
			margin: 0 0 2.4rem 0;
			color: var(--vscode-descriptionForeground);
		}

		.section-header {
			display: flex;
			align-items: center;
			justify-content: space-between;
			padding: 1.2rem;
			background: var(--vscode-editorGroupHeader-tabsBackground);
			border-bottom: 1px solid var(--vscode-panel-border);
			cursor: pointer;
			user-select: none;
		}

		.section-header:hover {
			background: var(--vscode-list-hoverBackground);
		}

		.section-header h4 {
			margin: 0;
			font-size: 1.1em;
			font-weight: 600;
		}

		.section-toggle {
			color: var(--vscode-descriptionForeground);
			transition: transform 0.2s ease;
		}

		.section-toggle.expanded {
			transform: rotate(90deg);
		}

		.section-content {
			padding: 0.8rem;
			overflow: hidden;
			box-sizing: border-box;
			display: flex;
			flex-direction: column;
		}

		/* Files changed section should expand to fill space */
		.section-content.files-changed {
			flex: 1;
			min-height: 0;
		}

		/* Commit message and AI explanation should have limited height */
		.section-content.commit-message,
		.section-content.ai-explanation {
			flex: 0 0 auto;
			max-height: 200px;
		}

		.section-content.collapsed {
			display: none;
		}

		.ai-explanation {
			color: var(--vscode-foreground);
			line-height: 1.5;
			margin: 0;
		}

		.ai-explanation.placeholder {
			color: var(--vscode-descriptionForeground);
			font-style: italic;
		}

		.unassigned-changes-item {
			padding: 1.2rem;
			border: 1px solid var(--vscode-panel-border);
			border-radius: 4px;
			background: var(--vscode-list-inactiveSelectionBackground);
			cursor: pointer;
			transition: all 0.2s ease;
			margin-bottom: 1.2rem;
			display: flex;
			align-items: center;
			gap: 0.8rem;
			user-select: none;
		}

		.unassigned-changes-item:hover {
			background: var(--vscode-list-hoverBackground);
		}

		.unassigned-changes-item.selected {
			background: var(--vscode-list-activeSelectionBackground);
			border-color: var(--vscode-focusBorder);
		}

		.unassigned-changes-item code-icon {
			color: var(--vscode-descriptionForeground);
		}

		.unassigned-changes-item .title {
			font-weight: 500;
			color: var(--vscode-foreground);
		}

		.unassigned-changes-item .count {
			color: var(--vscode-descriptionForeground);
			font-size: 0.9em;
		}

		.unassigned-changes-section {
			margin-bottom: 1.5rem;
		}

		.unassigned-changes-section:last-child {
			margin-bottom: 0;
		}

		/* Loading overlay styles */
		.loading-overlay {
			position: absolute;
			top: 0;
			left: 0;
			right: 0;
			bottom: 0;
			background: rgba(var(--vscode-editor-background-rgb, 30, 30, 30), 0.8);
			display: flex;
			align-items: center;
			justify-content: center;
			z-index: 100;
			backdrop-filter: blur(2px);
		}

		.loading-content {
			display: flex;
			flex-direction: column;
			align-items: center;
			gap: 1.2rem;
			padding: 2.4rem;
			background: var(--vscode-editor-background);
			border: 1px solid var(--vscode-panel-border);
			border-radius: 8px;
			box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
		}

		.loading-spinner {
			font-size: 2.4rem;
			color: var(--vscode-progressBar-background);
		}

		.loading-text {
			font-size: 1.4rem;
			color: var(--vscode-foreground);
			text-align: center;
			font-weight: 500;
		}

		/* Make main-content relative for absolute positioning of overlay */
		.main-content {
			position: relative;
		}
	`;

	@state()
	private selectedCommitId: string | null = null;

	@state()
	private selectedUnassignedSection: 'staged' | 'unstaged' | 'unassigned' | null = null;

	@state()
	private selectedCommitIds: Set<string> = new Set();

	@state()
	private selectedHunkId: string | null = null;

	@state()
	private selectedHunkIds: Set<string> = new Set();

	@state()
	private includeUnstagedChanges: boolean = false;

	private currentDropTarget: HTMLElement | null = null;
	private lastSelectedHunkId: string | null = null;

	@query('#commits-generated-modal')
	private commitsGeneratedModal!: HTMLDialogElement;

	private commitsSortable?: Sortable;
	private hunksSortable?: Sortable;
	private isDragging = false;
	private lastMouseEvent?: MouseEvent;

	override firstUpdated() {
		// Initialize reset state
		this.initializeResetState();
		// Delay initialization to ensure DOM is ready
		setTimeout(() => this.initializeSortable(), 200);
		this.initializeDragTracking();
	}

	override updated(changedProperties: Map<string | number | symbol, unknown>) {
		super.updated(changedProperties);

		// Reinitialize drop zones when commits change
		if (changedProperties.has('commits')) {
			setTimeout(() => this.initializeCommitDropZones(), 100);
		}
	}

	override disconnectedCallback() {
		super.disconnectedCallback?.();
		this.commitsSortable?.destroy();
		this.hunksSortable?.destroy();
		if (this.commitMessageDebounceTimer) {
			clearTimeout(this.commitMessageDebounceTimer);
		}
		this.commitMessageBeingEdited = null;
	}

	private initializeSortable() {
		// Initialize commits sortable
		const commitsContainer = this.shadowRoot?.querySelector('.commits-list');
		if (commitsContainer) {
			this.commitsSortable = Sortable.create(commitsContainer as HTMLElement, {
				animation: 150,
				ghostClass: 'sortable-ghost',
				chosenClass: 'sortable-chosen',
				dragClass: 'sortable-drag',
				handle: '.drag-handle', // Only allow dragging by the handle
				filter: '.new-commit-drop-zone',
				onMove: evt => {
					// Only allow moving within the commits list, not into drop zones
					const target = evt.related;
					return (
						target.tagName.toLowerCase() === 'gl-commit-item' &&
						!target.closest('.drop-zone') &&
						!target.closest('.new-commit-drop-zone')
					);
				},
				onEnd: evt => {
					if (evt.oldIndex !== undefined && evt.newIndex !== undefined && evt.oldIndex !== evt.newIndex) {
						this.reorderCommits(evt.oldIndex, evt.newIndex);
					}
				},
			});
		}

		// Initialize hunks sortable (will be re-initialized when commit is selected)
		this.initializeHunksSortable();

		// Initialize drop zones
		this.initializeAllDropZones();
	}

	private initializeHunksSortable() {
		// Destroy existing sortables
		this.hunksSortable?.destroy();

		// Find all hunks lists (could be multiple in split view)
		const hunksContainers = this.shadowRoot?.querySelectorAll('.hunks-list');
		if (hunksContainers && hunksContainers.length > 0) {
			hunksContainers.forEach(hunksContainer => {
				Sortable.create(hunksContainer as HTMLElement, {
					group: {
						name: 'hunks',
						pull: 'clone',
						put: true, // Allow dropping between split views
					},
					animation: 150,
					ghostClass: 'sortable-ghost',
					chosenClass: 'sortable-chosen',
					dragClass: 'sortable-drag',
					sort: false,
					onStart: evt => {
						this.isDragging = true;
						const draggedHunkId = evt.item.dataset.hunkId;
						if (draggedHunkId && this.selectedHunkIds.has(draggedHunkId) && this.selectedHunkIds.size > 1) {
							evt.item.dataset.multiDragHunkIds = Array.from(this.selectedHunkIds).join(',');
						}
						this.startAutoScroll();
					},
					onEnd: () => {
						this.isDragging = false;
						this.stopAutoScroll();
					},
					onAdd: evt => {
						const hunkId = evt.item.dataset.hunkId;
						const multiDragHunkIds = evt.item.dataset.multiDragHunkIds;
						const targetCommitId = evt.to.dataset.commitId;

						if (targetCommitId) {
							if (multiDragHunkIds && typeof multiDragHunkIds === 'string') {
								// Multi-drag: move all selected hunks
								const hunkIds = multiDragHunkIds.split(',');
								this.moveHunksToCommit(hunkIds, targetCommitId);
							} else if (hunkId) {
								// Single drag
								this.moveHunkToCommit(hunkId, targetCommitId);
							}
						}
						evt.item.remove();
					},
				});
			});
		}
	}

	private initializeAllDropZones() {
		// Initialize new commit drop zone
		const newCommitZone = this.shadowRoot?.querySelector('.new-commit-drop-zone');
		if (newCommitZone) {
			Sortable.create(newCommitZone as HTMLElement, {
				group: {
					name: 'hunks',
					pull: false,
					put: true,
				},
				animation: 150,
				onMove: evt => {
					// Only allow hunk items to be dropped here
					return evt.dragged.tagName.toLowerCase() === 'gl-hunk-item';
				},
				onAdd: evt => {
					const hunkId = evt.item.dataset.hunkId;
					const multiDragHunkIds = evt.item.dataset.multiDragHunkIds;

					if (multiDragHunkIds && typeof multiDragHunkIds === 'string') {
						// Multi-drag: create new commit with all selected hunks
						const hunkIds = multiDragHunkIds.split(',');
						this.createNewCommitWithHunks(hunkIds);
					} else if (hunkId) {
						// Single drag
						this.createNewCommitWithHunk(hunkId);
					}
					evt.item.remove();
				},
			});
		}

		// Initialize commit drop zones
		this.initializeCommitDropZones();
	}

	private initializeCommitDropZones() {
		// Wait a bit for the DOM to be ready
		setTimeout(() => {
			const commitElements = this.shadowRoot?.querySelectorAll('gl-commit-item');
			commitElements?.forEach(commitElement => {
				// Find the drop zone within each commit element's shadow DOM
				const dropZone = commitElement.shadowRoot?.querySelector('.drop-zone');
				if (dropZone) {
					Sortable.create(dropZone as HTMLElement, {
						group: {
							name: 'hunks',
							pull: false,
							put: true,
						},
						animation: 150,
						onMove: evt => {
							// Only allow hunk items to be dropped here
							return evt.dragged.tagName.toLowerCase() === 'gl-hunk-item';
						},
						onAdd: evt => {
							const hunkId = evt.item.dataset.hunkId;
							const multiDragHunkIds = evt.item.dataset.multiDragHunkIds;
							const targetCommitId = commitElement.dataset.commitId;

							if (targetCommitId) {
								if (multiDragHunkIds && typeof multiDragHunkIds === 'string') {
									// Multi-drag: move all selected hunks
									const hunkIds = multiDragHunkIds.split(',');
									this.moveHunksToCommit(hunkIds, targetCommitId);
								} else if (hunkId) {
									// Single drag
									this.moveHunkToCommit(hunkId, targetCommitId);
								}
							}
							evt.item.remove();
						},
					});
				}
			});
		}, 50);
	}

	// History management methods
	private createDataSnapshot(): ComposerDataSnapshot {
		return {
			hunks: JSON.parse(JSON.stringify(this.state?.hunks ?? [])),
			commits: JSON.parse(JSON.stringify(this.state?.commits ?? [])),
			selectedCommitId: this.state?.selectedCommitId ?? null,
			selectedCommitIds: new Set([...this.selectedCommitIds]),
			selectedUnassignedSection: this.state?.selectedUnassignedSection ?? null,
			selectedHunkIds: new Set([...this.selectedHunkIds]),
		};
	}

	private applyDataSnapshot(snapshot: ComposerDataSnapshot) {
		this.state.hunks = snapshot.hunks;
		this.state.commits = snapshot.commits;
		this.state.selectedCommitId = snapshot.selectedCommitId;
		this.selectedCommitIds = snapshot.selectedCommitIds;
		this.state.selectedUnassignedSection = snapshot.selectedUnassignedSection;
		this.selectedHunkIds = snapshot.selectedHunkIds;
		this.requestUpdate();
	}

	private saveToHistory() {
		// Clear redo stack when new action is performed
		this.history.redoStack = [];

		// Trim undo stack to (historyLimit - 1) before adding new snapshot
		while (this.history.undoStack.length >= historyLimit) {
			this.history.undoStack.shift(); // Remove oldest entries
		}

		// Save current state to undo stack
		this.history.undoStack.push(this.createDataSnapshot());
	}

	private initializeResetState() {
		if (!this.history.resetState) {
			this.history.resetState = this.createDataSnapshot();
		}
	}

	private canUndo(): boolean {
		return this.history.undoStack.length > 0;
	}

	private canRedo(): boolean {
		return this.history.redoStack.length > 0;
	}

	private undo() {
		if (!this.canUndo()) return;

		// Trim redo stack to (historyLimit - 1) before adding current state
		while (this.history.redoStack.length >= historyLimit) {
			this.history.redoStack.shift(); // Remove oldest entries
		}

		// Save current state to redo stack
		this.history.redoStack.push(this.createDataSnapshot());

		// Restore previous state
		const previousState = this.history.undoStack.pop()!;
		this.applyDataSnapshot(previousState);
	}

	private redo() {
		if (!this.canRedo()) return;

		// Trim undo stack to (historyLimit - 1) before adding current state
		while (this.history.undoStack.length >= historyLimit) {
			this.history.undoStack.shift(); // Remove oldest entries
		}

		// Save current state to undo stack
		this.history.undoStack.push(this.createDataSnapshot());

		// Restore next state
		const nextState = this.history.redoStack.pop()!;
		this.applyDataSnapshot(nextState);
	}

	private reset() {
		if (!this.history.resetState) return;

		// Save current state to undo stack
		this.saveToHistory();
		// Restore reset state
		this.applyDataSnapshot(this.history.resetState);
	}

	private reorderCommits(oldIndex: number, newIndex: number) {
		if (!this.canReorderCommits) return;

		this.saveToHistory();
		const newCommits = [...this.state.commits];

		// Since we display commits in reverse order (bottom to top), we need to convert
		// the display indices to actual array indices
		const actualOldIndex = newCommits.length - 1 - oldIndex;
		const actualNewIndex = newCommits.length - 1 - newIndex;

		const [movedCommit] = newCommits.splice(actualOldIndex, 1);
		newCommits.splice(actualNewIndex, 0, movedCommit);
		this.state.commits = newCommits;
		this.requestUpdate();
	}

	private handleHunkDragStart(hunkIds: string[]) {
		// Set dragging state and start auto-scroll
		this.isDragging = true;
		this.startAutoScroll();

		// Forward the drag start event to the commits panel
		const commitsPanel = this.shadowRoot?.querySelector('gl-commits-panel');
		if (commitsPanel) {
			commitsPanel.dispatchEvent(
				new CustomEvent('hunk-drag-start', {
					detail: { hunkIds: hunkIds },
					bubbles: true,
				}),
			);
		}
	}

	private handleHunkDragEnd() {
		// Forward the drag end event to the commits panel
		const commitsPanel = this.shadowRoot?.querySelector('gl-commits-panel');
		if (commitsPanel) {
			commitsPanel.dispatchEvent(
				new CustomEvent('hunk-drag-end', {
					bubbles: true,
				}),
			);
		}

		// Reset drag tracking
		this.currentDropTarget = null;
		this.isDragging = false;
		this.stopAutoScroll();
	}

	private initializeDragTracking() {
		// Add global drag event listeners to track current drop target
		document.addEventListener('dragover', e => {
			e.preventDefault();
			const target = e.target as HTMLElement;

			// Find the closest drop zone
			const dropZone = target.closest('.new-commit-drop-zone, .unassign-drop-zone, gl-commit-item');
			this.currentDropTarget = dropZone as HTMLElement;
		});

		document.addEventListener('dragleave', e => {
			// Only clear if we're leaving the document or going to a non-droppable area
			if (!e.relatedTarget || !(e.relatedTarget as HTMLElement).closest('.composer-container')) {
				this.currentDropTarget = null;
			}
		});

		document.addEventListener('drop', () => {
			// Reset after any drop
			this.currentDropTarget = null;
			this.isDragging = false;
		});
	}

	private handleHunkMove(hunkId: string, targetCommitId: string) {
		// Move hunk from source to target commit
		const hunkIndex = parseInt(hunkId, 10);

		// Remove hunk from source commit if it was assigned to one
		const sourceCommit = this.state.commits.find(commit => commit.hunkIndices.includes(hunkIndex));
		if (sourceCommit) {
			sourceCommit.hunkIndices = sourceCommit.hunkIndices.filter(index => index !== hunkIndex);
		}

		// Add hunk to target commit
		const targetCommit = this.state.commits.find(commit => commit.id === targetCommitId);
		if (targetCommit && !targetCommit.hunkIndices.includes(hunkIndex)) {
			targetCommit.hunkIndices.push(hunkIndex);
		}

		// Remove commits that no longer have any hunks
		this.state.commits = this.state.commits.filter(commit => commit.hunkIndices.length > 0);

		// Clear selections and trigger re-render
		this.selectedHunkIds = new Set();
		this.requestUpdate();
	}

	private createNewCommitWithHunks(hunkIds: string[]) {
		this.saveToHistory();
		// Convert hunk IDs to indices
		const hunkIndices = hunkIds.map(id => parseInt(id, 10)).filter(index => !isNaN(index));

		// Remove hunks from any existing commits
		this.state.commits.forEach(commit => {
			commit.hunkIndices = commit.hunkIndices.filter(index => !hunkIndices.includes(index));
		});

		// Create new commit
		const newCommit: ComposerCommit = {
			id: `commit-${Date.now()}`,
			message: `New Commit`,
			hunkIndices: hunkIndices,
		};

		// Add to commits
		this.state.commits.push(newCommit);

		// Update the state and trigger re-render
		this.state.commits = [...this.state.commits];
		this.selectedCommitId = newCommit.id;
		this.selectedCommitIds = new Set();
		this.selectedHunkIds = new Set();
		this.requestUpdate();
	}

	private unassignHunks(hunkIds: string[]) {
		this.saveToHistory();
		// Convert hunk IDs to indices
		const hunkIndices = hunkIds.map(id => parseInt(id, 10)).filter(index => !isNaN(index));

		// Remove hunks from all commits
		this.state.commits.forEach(commit => {
			commit.hunkIndices = commit.hunkIndices.filter(index => !hunkIndices.includes(index));
		});

		// Remove commits that no longer have any hunks
		this.state.commits = this.state.commits.filter(commit => commit.hunkIndices.length > 0);

		// Clear selections and trigger re-render
		this.selectedHunkIds = new Set();
		this.requestUpdate();
	}

	private moveHunksToCommit(hunkIds: string[], targetCommitId: string) {
		if (!this.canMoveHunks) return;

		this.saveToHistory();
		// Convert hunk IDs to indices
		const hunkIndices = hunkIds.map(id => parseInt(id, 10)).filter(index => !isNaN(index));

		// Remove hunks from source commits
		this.state.commits.forEach(commit => {
			commit.hunkIndices = commit.hunkIndices.filter(index => !hunkIndices.includes(index));
		});

		// Add hunks to target commit
		const targetCommit = this.state.commits.find(commit => commit.id === targetCommitId);
		if (targetCommit) {
			hunkIndices.forEach(index => {
				if (!targetCommit.hunkIndices.includes(index)) {
					targetCommit.hunkIndices.push(index);
				}
			});
		}

		// Remove commits that no longer have any hunks
		this.state.commits = this.state.commits.filter(commit => commit.hunkIndices.length > 0);

		// Clear selections and trigger re-render
		this.selectedHunkIds = new Set();
		this.requestUpdate();
	}

	private moveHunkToCommit(hunkId: string, targetCommitId: string) {
		this.moveHunksToCommit([hunkId], targetCommitId);
	}

	private createNewCommitWithHunk(hunkId: string) {
		this.createNewCommitWithHunks([hunkId]);
	}

	private selectHunk(hunkId: string, shiftKey = false) {
		if (shiftKey) {
			// Multi-select with shift key
			const newSelection = new Set(this.selectedHunkIds);

			// If we have a single selection and no multi-selection yet, add the current single selection to multi-selection
			if (this.selectedHunkId && this.selectedHunkIds.size === 0) {
				newSelection.add(this.selectedHunkId);
			}

			// If we have a previous selection, select range between last and current
			if (this.lastSelectedHunkId && this.lastSelectedHunkId !== hunkId) {
				const hunks = this.hunksWithAssignments;
				const lastIndex = hunks.findIndex(h => h.index.toString() === this.lastSelectedHunkId);
				const currentIndex = hunks.findIndex(h => h.index.toString() === hunkId);

				if (lastIndex !== -1 && currentIndex !== -1) {
					const startIndex = Math.min(lastIndex, currentIndex);
					const endIndex = Math.max(lastIndex, currentIndex);

					// Select all hunks in the range
					for (let i = startIndex; i <= endIndex; i++) {
						newSelection.add(hunks[i].index.toString());
					}
					return;
				}
			}

			// Toggle the clicked hunk in multi-selection
			if (newSelection.has(hunkId)) {
				newSelection.delete(hunkId);
			} else {
				newSelection.add(hunkId);
			}

			this.selectedHunkIds = newSelection;
			this.lastSelectedHunkId = hunkId;

			// If we have multi-selection, clear single selection
			if (this.selectedHunkIds.size > 1) {
				this.selectedHunkId = null;
			} else if (this.selectedHunkIds.size === 1) {
				this.selectedHunkId = Array.from(this.selectedHunkIds)[0];
				this.selectedHunkIds = new Set(); // Clear multi-selection when back to single
			} else {
				this.selectedHunkId = null;
			}
		} else {
			// Single select (clear multi-selection)
			this.selectedHunkIds = new Set();
			this.selectedHunkId = hunkId;
			this.lastSelectedHunkId = hunkId;
		}
	}

	private selectCommit(commitId: string, shiftKey = false) {
		if (shiftKey) {
			// Multi-select with shift key
			const newSelection = new Set(this.selectedCommitIds);

			// If we have a single selection and no multi-selection yet, add the current single selection to multi-selection
			if (this.selectedCommitId && this.selectedCommitIds.size === 0) {
				newSelection.add(this.selectedCommitId);
			}

			// Toggle the clicked commit in multi-selection
			if (newSelection.has(commitId)) {
				newSelection.delete(commitId);
			} else {
				newSelection.add(commitId);
			}

			this.selectedCommitIds = newSelection;

			// If we have multi-selection, clear single selection
			if (this.selectedCommitIds.size > 1) {
				this.selectedCommitId = null;
			} else if (this.selectedCommitIds.size === 1) {
				this.selectedCommitId = Array.from(this.selectedCommitIds)[0];
				this.selectedCommitIds = new Set(); // Clear multi-selection when back to single
			} else {
				this.selectedCommitId = null;
			}
		} else {
			// Single select (clear multi-selection)
			this.selectedCommitIds = new Set();
			this.selectedCommitId = commitId;
		}

		// Clear unassigned changes selection
		this.selectedUnassignedSection = null;

		// Reinitialize sortables after the DOM updates
		void this.updateComplete.then(() => {
			setTimeout(() => {
				this.initializeHunksSortable();
				this.initializeCommitDropZones();
			}, 50);
		});
	}

	private selectUnassignedSection(section: 'staged' | 'unstaged' | 'unassigned') {
		// Clear commit selection
		this.selectedCommitId = null;
		this.selectedCommitIds = new Set();

		// Select unassigned section
		this.selectedUnassignedSection = section;

		// Clear hunk selection
		this.selectedHunkId = null;
		this.selectedHunkIds = new Set();

		// Reinitialize sortables after the DOM updates to include unassigned hunks
		void this.updateComplete.then(() => {
			setTimeout(() => {
				this.initializeHunksSortable();
				this.initializeCommitDropZones();
			}, 50);
		});
	}

	private updateCommitMessage(commitId: string, message: string) {
		const commit = this.state.commits.find(c => c.id === commitId);
		if (commit) {
			// If this is the first change to this commit message, save a snapshot
			if (this.commitMessageBeingEdited !== commitId) {
				this.saveToHistory();
				this.commitMessageBeingEdited = commitId;
			}

			// Clear existing debounce timer
			if (this.commitMessageDebounceTimer) {
				clearTimeout(this.commitMessageDebounceTimer);
			}

			// Clear the editing state after 1 second of no changes
			this.commitMessageDebounceTimer = window.setTimeout(() => {
				this.commitMessageBeingEdited = null;
			}, 1000);

			commit.message = message;
			this.requestUpdate();
		}
	}

	private toggleCommitMessageExpanded() {
		this.state.detailsSectionExpanded.commitMessage = !this.state.detailsSectionExpanded.commitMessage;
		this.requestUpdate();
	}

	private toggleAiExplanationExpanded() {
		this.state.detailsSectionExpanded.aiExplanation = !this.state.detailsSectionExpanded.aiExplanation;
		this.requestUpdate();
	}

	private toggleFilesChangedExpanded() {
		this.state.detailsSectionExpanded.filesChanged = !this.state.detailsSectionExpanded.filesChanged;
		this.requestUpdate();
	}

	private autoScrollActive = false;
	private autoScrollTimer?: number;
	private mouseTracker = (e: MouseEvent) => {
		this.lastMouseEvent = e;
	};

	private startAutoScroll() {
		this.autoScrollActive = true;

		document.addEventListener('mousemove', this.mouseTracker, {
			passive: false,
			capture: true,
		});
		document.addEventListener('dragover', this.mouseTracker, {
			passive: false,
			capture: true,
		});
		document.addEventListener('pointermove', this.mouseTracker, {
			passive: false,
			capture: true,
		});

		this.autoScrollTimer = window.setInterval(() => {
			if (!this.autoScrollActive || !this.isDragging || !this.lastMouseEvent) {
				return;
			}

			try {
				this.performAutoScroll(this.lastMouseEvent.clientY);
			} catch {
				// Auto-scroll error - ignore
			}
		}, 50);
	}

	private stopAutoScroll() {
		this.autoScrollActive = false;

		if (this.autoScrollTimer) {
			clearInterval(this.autoScrollTimer);
			this.autoScrollTimer = undefined;
		}

		document.removeEventListener('mousemove', this.mouseTracker, true);
		document.removeEventListener('dragover', this.mouseTracker, true);
		document.removeEventListener('pointermove', this.mouseTracker, true);
	}

	private performAutoScroll(mouseY: number) {
		const scrollThreshold = 200;

		// Vertical scrolling for multi-commit details panel
		const detailsPanel = this.shadowRoot?.querySelector('.details-panel.split-view') as HTMLElement;
		if (detailsPanel && this.selectedCommitIds.size >= 2) {
			const rect = detailsPanel.getBoundingClientRect();
			const topDistance = mouseY - rect.top;
			const bottomDistance = rect.bottom - mouseY;

			if (topDistance >= 0 && topDistance < scrollThreshold && detailsPanel.scrollTop > 0) {
				detailsPanel.scrollBy(0, -50);
				return;
			}

			if (bottomDistance >= 0 && bottomDistance < scrollThreshold) {
				const maxScroll = detailsPanel.scrollHeight - detailsPanel.clientHeight;
				if (detailsPanel.scrollTop < maxScroll) {
					detailsPanel.scrollBy(0, 50);
					return;
				}
			}
		}

		// Vertical scrolling for commits panel
		const commitsPanel = this.shadowRoot?.querySelector('.commits-panel') as HTMLElement;
		if (commitsPanel) {
			const rect = commitsPanel.getBoundingClientRect();
			const topDistance = mouseY - rect.top;
			const bottomDistance = rect.bottom - mouseY;

			if (topDistance >= 0 && topDistance < scrollThreshold && commitsPanel.scrollTop > 0) {
				commitsPanel.scrollTop = Math.max(0, commitsPanel.scrollTop - 30);
			} else if (bottomDistance >= 0 && bottomDistance < scrollThreshold) {
				const maxScroll = commitsPanel.scrollHeight - commitsPanel.clientHeight;
				if (commitsPanel.scrollTop < maxScroll) {
					commitsPanel.scrollTop = Math.min(maxScroll, commitsPanel.scrollTop + 30);
				}
			}
		}
	}

	private closeModal() {
		this.commitsGeneratedModal.close();
		// Close the webview
		window.close();
	}

	private openModal() {
		this.commitsGeneratedModal.showModal();
	}

	private get hunksWithAssignments(): ComposerHunk[] {
		if (!this.state?.hunks || !this.state?.commits) {
			return [];
		}

		return updateHunkAssignments(this.state.hunks, this.state.commits);
	}

	private get aiEnabled(): boolean {
		return this.state?.aiEnabled?.org === true && this.state?.aiEnabled?.config === true;
	}

	private get canFinishAndCommit(): boolean {
		return this.state.commits.length > 0;
	}

	private get isAIPreviewMode(): boolean {
		return this.state?.mode === 'ai-preview';
	}

	private get canReorderCommits(): boolean {
		return !this.isAIPreviewMode;
	}

	private get canCombineCommits(): boolean {
		return !this.isAIPreviewMode;
	}

	private get showHistoryButtons(): boolean {
		return true; // Show history buttons in both interactive and AI preview modes
	}

	private get canMoveHunks(): boolean {
		return !this.isAIPreviewMode;
	}

	private get canGenerateCommitsWithAI(): boolean {
		if (!this.aiEnabled) return false;

		// Check if there are any eligible hunks for AI generation
		const eligibleHunks = this.getEligibleHunksForAI(this.includeUnstagedChanges);
		return eligibleHunks.length > 0;
	}

	private getEligibleHunksForAI(includeUnstagedChanges: boolean): typeof this.hunksWithAssignments {
		let availableHunks: typeof this.hunksWithAssignments;

		if (this.isAIPreviewMode) {
			// In AI preview mode, treat all hunks as available (ignore existing commits)
			availableHunks = this.hunksWithAssignments;
		} else {
			// In interactive mode, only consider unassigned hunks
			const assignedHunkIndices = new Set<number>();
			this.state.commits.forEach(commit => {
				commit.hunkIndices.forEach(index => assignedHunkIndices.add(index));
			});
			availableHunks = this.hunksWithAssignments.filter(hunk => !assignedHunkIndices.has(hunk.index));
		}

		// Apply filtering logic based on includeUnstagedChanges
		if (!includeUnstagedChanges) {
			const hasStagedChanges = availableHunks.some(hunk => hunk.source === 'staged');
			const hasNonUnstagedChanges = availableHunks.some(hunk => hunk.source !== 'unstaged');

			if (hasStagedChanges) {
				// If staged changes exist, only use staged changes
				return availableHunks.filter(hunk => hunk.source === 'staged');
			} else if (hasNonUnstagedChanges) {
				// If changes NOT from unstaged exist, only use those
				return availableHunks.filter(hunk => hunk.source !== 'unstaged');
			}
			// Otherwise, use all available hunks
			return availableHunks;
		}
		// Include all available hunks when checkbox is checked
		return availableHunks;
	}

	private get canEditCommitMessages(): boolean {
		return true; // Always allowed
	}

	private get canGenerateCommitMessages(): boolean {
		return this.aiEnabled; // Allowed in both modes if AI is enabled
	}

	private composeCommits() {
		this._ipc.sendCommand(FinishAndCommitCommand, {
			commits: this.state.commits,
			hunks: this.hunksWithAssignments,
			baseCommit: this.state.baseCommit,
		});
	}

	private handleGenerateCommitsWithAI(e: CustomEvent) {
		this.includeUnstagedChanges = e.detail?.includeUnstagedChanges ?? false;
		this.generateCommitsWithAI(e.detail?.includeUnstagedChanges);
	}

	private handleIncludeUnstagedChange(e: CustomEvent) {
		this.includeUnstagedChanges = e.detail?.includeUnstagedChanges ?? false;
	}

	@query('gl-details-panel')
	private detailsPanel!: DetailsPanel;

	private handleFocusCommitMessage(e: CustomEvent) {
		const commitId = e.detail?.commitId;
		if (!commitId) return;

		// Select the commit first
		this.selectedCommitId = commitId;
		this.selectedCommitIds.clear();
		this.selectedCommitIds.add(commitId);
		this.selectedUnassignedSection = null;

		// Focus the commit message input in the details panel
		this.requestUpdate();

		// Use a small delay to ensure the details panel has rendered and focus the input
		setTimeout(() => {
			this.detailsPanel?.focusCommitMessageInput?.(commitId);
		}, 100);
	}

	private generateCommitsWithAI(includeUnstagedChanges: boolean = false) {
		if (!this.aiEnabled) return;

		// Get eligible hunks using the shared logic
		const hunksToGenerate = this.getEligibleHunksForAI(includeUnstagedChanges);

		// Early return if no eligible hunks (this should be prevented by UI, but safety check)
		if (hunksToGenerate.length === 0) {
			return;
		}

		this.saveToHistory();

		this._ipc.sendCommand(GenerateCommitsCommand, {
			hunks: hunksToGenerate,
			// In AI preview mode, send empty commits array to overwrite existing commits
			// In interactive mode, send existing commits to preserve them
			commits: this.isAIPreviewMode ? [] : this.state.commits,
			hunkMap: this.state.hunkMap,
			baseCommit: this.state.baseCommit,
		});
	}

	private generateCommitMessage(commitId: string) {
		if (!this.canGenerateCommitMessages) return;

		// Find the commit
		const commit = this.state.commits.find(c => c.id === commitId);
		if (!commit) {
			return;
		}

		// Create combined diff for the commit
		const { patch } = createCombinedDiffForCommit(commit, this.hunksWithAssignments);
		if (!patch) {
			return;
		}

		this._ipc.sendCommand(GenerateCommitMessageCommand, {
			commitId: commitId,
			diff: patch,
		});
	}

	private combineSelectedCommits() {
		if (this.selectedCommitIds.size < 2 || !this.canCombineCommits) return;

		this.saveToHistory();

		const selectedCommits = this.state.commits.filter(c => this.selectedCommitIds.has(c.id));

		// Combine all hunk indices from selected commits
		const combinedHunkIndices: number[] = [];
		selectedCommits.forEach(commit => {
			combinedHunkIndices.push(...commit.hunkIndices);
		});

		// Combine commit messages from selected commits
		const combinedMessage = selectedCommits
			.map(commit => commit.message)
			.filter(message => message && message.trim() !== '')
			.join('\n\n');

		// Combine AI explanations from selected commits
		const combinedExplanation = selectedCommits
			.map(commit => commit.aiExplanation)
			.filter(explanation => explanation && explanation.trim() !== '')
			.join('\n\n');

		// Create new combined commit
		const combinedCommit: ComposerCommit = {
			id: `commit-${Date.now()}`,
			message: combinedMessage || 'Combined commit',
			hunkIndices: combinedHunkIndices,
			aiExplanation: combinedExplanation || undefined,
		};

		// Create new commits array by replacing selected commits with combined commit
		const newCommits: ComposerCommit[] = [];
		let combinedCommitInserted = false;

		this.state.commits.forEach(commit => {
			if (this.selectedCommitIds.has(commit.id)) {
				if (!combinedCommitInserted) {
					newCommits.push(combinedCommit);
					combinedCommitInserted = true;
				}
			} else {
				newCommits.push(commit);
			}
		});

		this.state.commits = newCommits;
		this.selectedCommitIds = new Set();
		this.selectedCommitId = combinedCommit.id;
		this.requestUpdate();
	}

	override render() {
		// Check if state is ready
		if (!this.state?.commits || !this.state?.hunks) {
			return html`<div class="loading">Loading...</div>`;
		}

		// Include both single selected commit and multi-selected commits
		const selectedCommitIds = new Set(this.selectedCommitIds);
		if (this.selectedCommitId && !this.selectedUnassignedSection) {
			selectedCommitIds.add(this.selectedCommitId);
		}
		const selectedCommits = Array.from(selectedCommitIds)
			.map(id => this.state.commits.find(c => c.id === id))
			.filter(Boolean) as ComposerCommit[];

		// Get hunks with updated assignments
		const hunks = this.hunksWithAssignments;

		return html`
			<header class="header">
				<h1>GitLens Composer</h1>
			</header>

			<main class="main-content">
				<gl-commits-panel
					.commits=${this.state.commits}
					.hunks=${hunks}
					.selectedCommitId=${this.selectedCommitId}
					.selectedCommitIds=${this.selectedCommitIds}
					.selectedUnassignedSection=${this.selectedUnassignedSection}
					.canFinishAndCommit=${this.canFinishAndCommit}
					.generating=${this.state.generatingCommits}
					.committing=${this.state.committing}
					.aiEnabled=${this.aiEnabled}
					.canReorderCommits=${this.canReorderCommits}
					.canCombineCommits=${this.canCombineCommits}
					.canMoveHunks=${this.canMoveHunks}
					.canGenerateCommitsWithAI=${this.canGenerateCommitsWithAI}
					.isAIPreviewMode=${this.isAIPreviewMode}
					.baseCommit=${this.state.baseCommit}
					.includeUnstagedChanges=${this.includeUnstagedChanges}
					@commit-select=${(e: CustomEvent) => this.selectCommit(e.detail.commitId, e.detail.multiSelect)}
					@unassigned-select=${(e: CustomEvent) => this.selectUnassignedSection(e.detail.section)}
					@combine-commits=${this.combineSelectedCommits}
					@finish-and-commit=${this.composeCommits}
					@generate-commits-with-ai=${this.handleGenerateCommitsWithAI}
					@include-unstaged-change=${this.handleIncludeUnstagedChange}
					@focus-commit-message=${this.handleFocusCommitMessage}
					@commit-reorder=${(e: CustomEvent) => this.reorderCommits(e.detail.oldIndex, e.detail.newIndex)}
					@create-new-commit=${(e: CustomEvent) => this.createNewCommitWithHunks(e.detail.hunkIds)}
					@unassign-hunks=${(e: CustomEvent) => this.unassignHunks(e.detail.hunkIds)}
					@move-hunks-to-commit=${(e: CustomEvent) =>
						this.moveHunksToCommit(e.detail.hunkIds, e.detail.targetCommitId)}
				></gl-commits-panel>

				<gl-details-panel
					.selectedCommits=${selectedCommits}
					.hunks=${hunks}
					.selectedUnassignedSection=${this.selectedUnassignedSection}
					.commitMessageExpanded=${this.state.detailsSectionExpanded.commitMessage}
					.aiExplanationExpanded=${this.state.detailsSectionExpanded.aiExplanation}
					.filesChangedExpanded=${this.state.detailsSectionExpanded.filesChanged}
					.selectedHunkIds=${this.selectedHunkIds}
					.generatingCommitMessage=${this.state.generatingCommitMessage}
					.committing=${this.state.committing}
					.canEditCommitMessages=${this.canEditCommitMessages}
					.canGenerateCommitMessages=${this.canGenerateCommitMessages}
					.canMoveHunks=${this.canMoveHunks}
					.aiEnabled=${this.aiEnabled}
					.isAIPreviewMode=${this.isAIPreviewMode}
					.showHistoryButtons=${this.showHistoryButtons}
					.canUndo=${this.canUndo()}
					.canRedo=${this.canRedo()}
					@toggle-commit-message=${this.toggleCommitMessageExpanded}
					@toggle-ai-explanation=${this.toggleAiExplanationExpanded}
					@toggle-files-changed=${this.toggleFilesChangedExpanded}
					@update-commit-message=${(e: CustomEvent) =>
						this.updateCommitMessage(e.detail.commitId, e.detail.message)}
					@generate-commit-message=${(e: CustomEvent) => this.generateCommitMessage(e.detail.commitId)}
					@hunk-selected=${(e: CustomEvent) => this.selectHunk(e.detail.hunkId, e.detail.shiftKey)}
					@hunk-drag-start=${(e: CustomEvent) => this.handleHunkDragStart(e.detail.hunkIds)}
					@hunk-drag-end=${() => this.handleHunkDragEnd()}
					@hunk-move=${(e: CustomEvent) => this.handleHunkMove(e.detail.hunkId, e.detail.targetCommitId)}
					@move-hunks-to-commit=${(e: CustomEvent) =>
						this.moveHunksToCommit(e.detail.hunkIds, e.detail.targetCommitId)}
					@history-undo=${this.undo}
					@history-redo=${this.redo}
					@history-reset=${this.reset}
				></gl-details-panel>

				<!-- Loading overlay for AI operations -->
				${when(
					this.state.generatingCommits || this.state.generatingCommitMessage,
					() => html`
						<div class="loading-overlay">
							<div class="loading-content">
								<code-icon icon="loading~spin" class="loading-spinner"></code-icon>
								<div class="loading-text">
									${this.state.generatingCommits
										? 'Generating commits with AI...'
										: 'Generating commit message with AI...'}
								</div>
							</div>
						</div>
					`,
				)}
			</main>

			<dialog id="commits-generated-modal" class="modal">
				<h2>Commits Generated</h2>
				<p>${this.state.commits.length} commits have been generated successfully!</p>
				<gl-button @click=${this.closeModal}>Exit Composer</gl-button>
			</dialog>
		`;
	}
}
