import { debounce } from "debounce";
import * as fs from "fs";
import * as recursiveReadDir from "recursive-readdir";
import * as vscode from "vscode";
import { setsAreEqual } from "./sets";
import { FileNode, fileNodeSort } from "./tag-tree/file-node";
import { TagNode, tagNodeSort } from "./tag-tree/tag-node";
import { TagTree } from "./tag-tree/tag-tree";

interface IFileInfo {
  tags: Set<string>;
  filePath: string;
}

class TagTreeDataProvider
  implements vscode.TreeDataProvider<TagNode | FileNode> {
  private tagTree: TagTree;
  // Responsible for notifying the TreeDataProvider to update for the specified element in tagTree
  private _onDidChangeTreeData: vscode.EventEmitter< TagNode | FileNode | null> = new vscode.EventEmitter<TagNode | FileNode | null>();
  /*
   * An optional event to signal that an element or root has changed.
   * This will trigger the view to update the changed element/root and its children recursively (if shown).
   * To signal that root has changed, do not pass any argument or pass undefined or null.
   */
  readonly onDidChangeTreeData: vscode.Event< TagNode | FileNode | null> = this._onDidChangeTreeData.event;

  constructor() {
    /* Register the extension to events of interest
     * Debounce to improve performance. Otherwise a file read would occur during each of the user's change to the document.
     */
    vscode.workspace.onDidChangeTextDocument(debounce((e: vscode.TextDocumentChangeEvent) => this.onDocumentChanged(e), 500));
    vscode.workspace.onWillSaveTextDocument((e) => {
      this.onWillSaveTextDocument(e);
    });

    this.tagTree = new TagTree();

    /* Add all files in the current workspace folder to the tag tree
     * @ts-ignore
     */
    if (vscode.workspace.workspaceFolders!.length > 0) {
      vscode.workspace.workspaceFolders!.forEach(workspaceFolder => {
        const { fsPath } = workspaceFolder.uri;
        recursiveReadDir(fsPath, ["!*.md"], (error: any, files: any) => {
            for (const filePath of files) {
                const fileInfo = this.getTagsFromFileOnFileSystem(filePath);
                if (fileInfo.tags.size > 0) {
                  this.tagTree.addFile(fileInfo.filePath, [...fileInfo.tags], fileInfo.filePath);
                }
            }

            this._onDidChangeTreeData.fire();
          });
      });
    }
  }

  /**
   * Required for implementing TreeDataProvider interface.
   *
   * @param {(TagNode | FileNode)} element
   * @returns
   * @memberof TagTreeDataProvider
   */
  public getChildren(element: TagNode | FileNode) {
    if (element instanceof FileNode) {
      return [];
    } else if (element === undefined) {
      // Convert the tags and files sets to arrays, then sort the arrays add tags first, then files
      const children = [
        ...[...this.tagTree.root.tags.values()]
        .sort(tagNodeSort),
        ...[...this.tagTree.root.files.values()]
        .sort(fileNodeSort)
      ];

      return children;
    } else {
      // Convert the tags and files sets to arrays, then sort the arrays add tags first, then files
      const children = [
        ...[...element.tags.values()].sort(tagNodeSort),
        ...[...element.files.values()].sort(fileNodeSort)
        ];

      return children;
    }
  }

  /**
   * Required for implementing TreeDataProvider interface.
   *
   * @param {(TagNode | FileNode)} element
   * @returns {vscode.TreeItem}
   * @memberof TagTreeDataProvider
   */
  public getTreeItem(element: TagNode | FileNode): vscode.TreeItem {
    const tagTreeNode = this.tagTree.getNode(element.pathToNode);
    const { displayName } = tagTreeNode;
    const isFile = tagTreeNode instanceof FileNode;

    const collapsibleState = isFile
      ? vscode.TreeItemCollapsibleState.None
      : vscode.TreeItemCollapsibleState.Collapsed;

    return new vscode.TreeItem(displayName, collapsibleState);
  }

  /**
   * Update the ui view if the document that is about to be saved has a different set of tags than
   * what is located in the currentState of the tag tree. This keeps the tree view in sync with
   * any changes to tags for a document before saving.
   * @param changeEvent
   */
  private onWillSaveTextDocument(changeEvent: vscode.TextDocumentWillSaveEvent) {
    if (changeEvent.document.isDirty && changeEvent.document.languageId === "markdown") {
      const filePath = changeEvent.document.fileName;
      const fileInfo = this.getTagsFromFileOnFileSystem(filePath);
      const tagsInTreeForFile = this.tagTree.getTagsForFile(filePath);
      this.updateTreeForFile(filePath, tagsInTreeForFile, fileInfo.tags);
    }
  }

  /**
   * Updates the tagTree and the ui tree view upon _every_ _single_ _change_ (saved or unsaved)
   * to a document. This method helps to keep the tag contents of the document in sync with the
   * tag tree view in the UI. This method fires for documents that have already been written to
   * the file system or are still in memory.
   *
   * @param changeEvent
   */
  private onDocumentChanged(changeEvent: vscode.TextDocumentChangeEvent): void {
    const filePath = changeEvent.document.fileName;
    // If the file has been saved and the file is a markdown file allow for making changes to the tag tree
    if (filePath !== undefined && changeEvent.document.languageId === "markdown") {
      const fileInfo = this.getTagsFromFileText(changeEvent.document.getText(), filePath);
      const tagsInTreeForFile = this.tagTree.getTagsForFile(filePath);
      const isUpdateNeeded = !setsAreEqual(fileInfo.tags, tagsInTreeForFile);
      /*
      * This could be potentially performance intensive due to the number of changes that could
      * be made to a document and how large the document is. There will definitely need to be some
      * work done around TagTree to make sure that the code
      */
      if (isUpdateNeeded) {
        this.tagTree.deleteFile(filePath);
        this.tagTree.addFile(filePath, [...fileInfo.tags.values()], filePath);
        // TODO: (bdietz) - this._onDidChangeTreeData.fire(specificNode?)
        this._onDidChangeTreeData.fire();
      }
    }
  }

  /**
   *
   * @param filePath The uri path to the file
   * @param tagsBefore The tags before a change to the document
   * @param tagsAfter The tags after a change to the document
   */
  private updateTreeForFile(filePath: string, tagsBefore: Set<string>, tagsAfter: Set<string>) {
      const isUpdateNeeded = !setsAreEqual(tagsBefore, tagsAfter);
      if (isUpdateNeeded) {
        this.tagTree.deleteFile(filePath);
        this.tagTree.addFile(filePath, [...tagsAfter.values()], filePath);
        /*
         * TODO (bdietz) - this._onDidChangeTreeData.fire(specificNode?)
         * specifying the specific node would help to improve the efficiency of the tree refresh.
         * Right now null/undefined being passed in fires off a refresh for the root of the tag tree.
         * I wonder if all the parents that have been impacted should be returned from the tag tree
         * for a fileDelete.
         */
        this._onDidChangeTreeData.fire();
      }
  }

  // TODO: (bdietz) - the method names of getTagsFrom* are kind of misleading because they return a FileInfo object.

  /**
   * Retrieves tags for a file's text content without accessing the file system.
   *
   * @param fileContents The document text
   * @param filePath The local filesystem path
   */
  private getTagsFromFileText(fileContents: string, filePath: string): IFileInfo {
    return fileContents
        .split("\n")
        .reduce((accumulator, currentLine) => {
          if (currentLine.includes('@nested-tags:')) {
            // @ts-ignore
            const tagsToAdd = currentLine
            .split('@nested-tags:')
            .pop()
            .split('-->')[0]
            .split(',');
            return {...accumulator, tags: new Set([...accumulator.tags,...tagsToAdd])};
          }

          return accumulator;
        }, { tags: new Set(), filePath });
  }

  /**
   * Retrieves tags for a file on the file system.
   *
   * @param filePath The local filesystem path
   */
  private getTagsFromFileOnFileSystem(filePath: string): IFileInfo {
      return this.getTagsFromFileText(fs.readFileSync(filePath).toString(), filePath);
    }
}

export { TagTreeDataProvider };
