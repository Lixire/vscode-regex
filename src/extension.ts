/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
'use strict';

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    IPCMessageReader, IPCMessageWriter,
    createConnection, IConnection,
    InitializeParams, CancellationToken,
    InitializeResult, DiagnosticSeverity
} from 'vscode-languageserver';

export function activate(context: vscode.ExtensionContext) {
    let counter = 0;
    const regexRegex = /^(\s*)("regexp":) "(.+)",$/g;
    const multiRegexRegex = /^(\s*)"pattern":\s*\[/g;
    const regexHighlight = vscode.window.createTextEditorDecorationType({ backgroundColor: 'rgba(100,100,100,.35)' });
    const matchHighlight = vscode.window.createTextEditorDecorationType({ backgroundColor: 'rgba(255,255,0,.35)' });

    const matchesFilePath = context.asAbsolutePath('resources/sample.txt');
    const matchesFileContent = fs.readFileSync(matchesFilePath, 'utf8');
    const legacyMatchesFileUri = vscode.Uri.parse(`untitled:${path.sep}Regex Matches`);
    const languages = ['json'];

    const decorators = new Map<vscode.TextEditor, RegexMatchDecorator>();

    const editor = vscode.window.activeTextEditor;

    let problemsCollection: any[] = [];

    context.subscriptions.push(vscode.commands.registerCommand('extension.toggleRegexPreview', toggleRegexPreview));

    languages.forEach(language => {
        context.subscriptions.push(vscode.languages.registerCodeLensProvider(language, { provideCodeLenses }));
    });

    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => updateDecorators(findRegexEditor())));

    const interval = setInterval(() => updateDecorators(), 5000);
    context.subscriptions.push({ dispose: () => clearInterval(interval) });

    let source = `Regex`;
    let diagnosticCollection: vscode.DiagnosticCollection = vscode.languages.createDiagnosticCollection(source);
    if (editor) {
        let basicUri = editor.document.uri;
        let diagnosticCollections = [];
        diagnosticCollections.push(diagnosticCollection);
        let basicPath = basicUri.path;
        basicPath = basicPath.slice(0, basicPath.lastIndexOf('/'));
    }

    function provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken) {
        counter = 0;
        const matches = findRegexes(document).concat(findMultiRegexes(document, problemsCollection));
        return matches.map(match => new vscode.CodeLens(match.range, {
            title: 'Test Regex...',
            command: 'extension.toggleRegexPreview',
            arguments: [match]
        }));
    }

    let addGMEnabled = true;
    const toggleGM = vscode.window.createStatusBarItem();
    toggleGM.command = 'regexpreview.toggleGM';
    context.subscriptions.push(toggleGM);
    context.subscriptions.push(vscode.commands.registerCommand('regexpreview.toggleGM', () => {
        addGMEnabled = !addGMEnabled;
        updateToggleGM();
        for (const decorator of decorators.values()) {
            decorator.update();
        }
    }))
    function updateToggleGM() {
        toggleGM.text = addGMEnabled ? 'Adding /gm' : 'Not adding /gm';
        toggleGM.tooltip = addGMEnabled ? 'Click to stop adding global and multiline (/gm) options to regexes for evaluation with example text.' : 'Click to add global and multiline (/gm) options to regexes for evaluation with example text.'
    }
    updateToggleGM();
    function addGM(regex: RegExp) {
        if (!addGMEnabled || (regex.global && regex.multiline)) {
            return regex;
        }

        let flags = regex.flags;
        if (!regex.global) {
            flags += 'g';
        }
        if (!regex.multiline) {
            flags += 'm';
        }
        return new RegExp(regex.source, flags);
    }

    let enabled = false;
    function toggleRegexPreview(initialRegexMatch?: RegexMatch) {
        enabled = !enabled || !!initialRegexMatch && !!initialRegexMatch.regex;
        toggleGM[enabled ? 'show' : 'hide']();
        if (enabled) {
            const visibleEditors = getVisibleTextEditors();
            if (visibleEditors.length === 1) {
                return openLoremIpsum(visibleEditors[0].viewColumn! + 1, initialRegexMatch);
            } else {
                updateDecorators(findRegexEditor(), initialRegexMatch);
            }
        } else {
            decorators.forEach(decorator => decorator.dispose());
        }
    }

    function openLoremIpsum(column: number, initialRegexMatch?: RegexMatch) {
        return fileExists(legacyMatchesFileUri.fsPath).then(exists => {
            return (exists ? vscode.workspace.openTextDocument(legacyMatchesFileUri.with({ scheme: 'file' })) :
                vscode.workspace.openTextDocument({ language: 'text', content: matchesFileContent }))
                .then(document => {
                    return vscode.window.showTextDocument(document, column, true);
                }).then(editor => {
                    updateDecorators(findRegexEditor(), initialRegexMatch);
                });
        }).then(null, reason => {
            vscode.window.showErrorMessage(reason);
        });
    }

    function fileExists(path: string): Promise<boolean> {
        return new Promise((resolve, reject) => {
            fs.lstat(path, (err, stats) => {
                if (!err) {
                    resolve(true);
                } else if (err.code === 'ENOENT') {
                    resolve(false);
                } else {
                    reject(err);
                }
            });
        });
    }

    function updateDecorators(regexEditor?: vscode.TextEditor, initialRegexMatch?: RegexMatch) {
        if (!enabled) {
            return;
        }

        // TODO: figure out why originEditor.document is sometimes a different object
        if (regexEditor && initialRegexMatch && initialRegexMatch.document && initialRegexMatch.document.uri.toString() === regexEditor.document.uri.toString()) {
            initialRegexMatch.document = regexEditor.document;
        }

        const remove = new Map(decorators);
        getVisibleTextEditors().forEach(editor => {
            remove.delete(editor);
            applyDecorator(editor, regexEditor, initialRegexMatch);
        });
        remove.forEach(decorator => decorator.dispose());
    }

    function getVisibleTextEditors() {
        return vscode.window.visibleTextEditors.filter(editor => typeof editor.viewColumn === 'number');
    }

    function applyDecorator(matchEditor: vscode.TextEditor, initialRegexEditor?: vscode.TextEditor, initialRegexMatch?: RegexMatch) {
        let decorator = decorators.get(matchEditor);
        const newDecorator = !decorator;
        if (newDecorator) {
            decorator = new RegexMatchDecorator(matchEditor);
            context.subscriptions.push(decorator);
            decorators.set(matchEditor, decorator);
        }
        if (newDecorator || initialRegexEditor || initialRegexMatch) {
            decorator!.apply(initialRegexEditor, initialRegexMatch);
        }
    }

    function discardDecorator(matchEditor: vscode.TextEditor) {
        decorators.delete(matchEditor);
    }

    interface RegexMatch {

        document: vscode.TextDocument;

        regex: RegExp;

        range: vscode.Range;

        group?: RegExp[];

        index?: number;

    }

    interface Match {

        range: vscode.Range;
    }

    class RegexMatchDecorator {

        private stableRegexEditor?: vscode.TextEditor;
        private stableRegexMatch?: RegexMatch;
        private disposables: vscode.Disposable[] = [];

        constructor(private matchEditor: vscode.TextEditor) {

            this.disposables.push(vscode.workspace.onDidCloseTextDocument(e => {
                if (this.stableRegexEditor && e === this.stableRegexEditor.document) {
                    this.stableRegexEditor = undefined;
                    this.stableRegexMatch = undefined;
                    matchEditor.setDecorations(matchHighlight, []);
                } else if (e === matchEditor.document) {
                    this.dispose();
                }
            }));

            this.disposables.push(vscode.workspace.onDidChangeTextDocument(e => {
                if ((this.stableRegexEditor && e.document === this.stableRegexEditor.document) || e.document === matchEditor.document) {
                    this.update();
                }
            }));

            this.disposables.push(vscode.window.onDidChangeTextEditorSelection(e => {
                if (this.stableRegexEditor && e.textEditor === this.stableRegexEditor) {
                    this.stableRegexMatch = undefined;
                    this.update();
                }
            }));

            this.disposables.push(vscode.window.onDidChangeActiveTextEditor(e => {
                this.update();
            }));

            this.disposables.push({
                dispose: () => {
                    matchEditor.setDecorations(matchHighlight, []);
                    matchEditor.setDecorations(regexHighlight, []);
                }
            });
        }

        public apply(stableRegexEditor?: vscode.TextEditor, stableRegexMatch?: RegexMatch) {
            this.stableRegexEditor = stableRegexEditor;
            this.stableRegexMatch = stableRegexMatch;
            this.update();
        }

        public dispose() {
            discardDecorator(this.matchEditor);
            this.disposables.forEach(disposable => {
                disposable.dispose();
            });
        }

        public update() {
            const regexEditor = this.stableRegexEditor = findRegexEditor() || this.stableRegexEditor;
            let regex = regexEditor && findRegexAtCaret(regexEditor);
            if (this.stableRegexMatch) {
                if (regex || !regexEditor || regexEditor.document !== this.stableRegexMatch.document) {
                    this.stableRegexMatch = undefined;
                } else {
                    regex = this.stableRegexMatch;
                }
            }
            const matches = regex && regexEditor !== this.matchEditor ? findMatches(regex, this.matchEditor.document) : [];
            this.matchEditor.setDecorations(matchHighlight, matches.map(match => match.range));

            if (regexEditor) {
                regexEditor.setDecorations(regexHighlight, (this.stableRegexMatch || regexEditor !== vscode.window.activeTextEditor) && regex ? [regex.range] : []);
            }
        }
    }

    function findRegexEditor() {
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor || languages.indexOf(activeEditor.document.languageId) === -1) {
            return undefined;
        }
        return activeEditor;
    }

    function findRegexAtCaret(editor: vscode.TextEditor): RegexMatch | undefined {
        const anchor = editor.selection.anchor;
        const line = editor.document.lineAt(anchor);
        const text = line.text.substr(0, 1000);

        let match: RegExpExecArray | null;
        let regex = getRegexRegex(true);
        regex.lastIndex = 0;
        while ((match = regex.exec(text)) && (match.index + match[1].length + match[2].length < anchor.character));
        if (match && match.index + match[1].length <= anchor.character) {
            return createRegexMatch(editor.document, anchor.line, match, 3);
        }
    }

    function findRegexes(document: vscode.TextDocument) {
        problemsCollection = [];
        const matches: RegexMatch[] = [];
        for (let i = 0; i < document.lineCount; i++) {
            const line = document.lineAt(i);
            let regex = getRegexRegex(true);
            let match: RegExpExecArray | null;
            regex.lastIndex = 0;
            const text = line.text.substr(0, 1000);
            while ((match = regex.exec(text))) {
                if (match.length >= 4) {
                    match[3] = match[3].split('\\\\').join('\\');
                }
                const result = createRegexMatch(document, i, match, 3);
                if (result) {
                    matches.push(result);
                }
            }
        }

        return matches
    }

    function findMultiRegexes(document: vscode.TextDocument, problemsCollection: any[]) {
        const matches: RegexMatch[] = [];
        let documentText = JSON.parse(document.getText());
        let problems = null;
        if (documentText['contributes']) {
            problems = documentText['contributes']['problemMatchers'];
        }
        // for multiline pms
        let locationOfRegex = [];
        for (let i = 0; i < document.lineCount; i++) {
            const line = document.lineAt(i);
            let regex = getRegexRegex(false);
            let match: RegExpExecArray | null;
            regex.lastIndex = 0;
            const text = line.text.substr(0, 1000);
            while ((match = regex.exec(text))) {
                locationOfRegex.push(i);
            }
        }

        if (problems) {
            for (let i = 0; i < problems.length; i++) {
                const mult = problems[i]['pattern'];
                let line = [];
                if (mult) {
                    let multiReg = [];
                    // get all the regexes for the multiline problem matcher
                    for (let j = 0; j < mult.length; ++j) {
                        if (mult[j]['regexp']) {
                            multiReg.push(mult[j]['regexp']);
                        }
                    }
                    if (multiReg.length > 0) {
                        if (mult[mult.length - 1]['loop'] === true) {
                            // if the loop property is true, we allow one or more instances of the last regex
                            multiReg[multiReg.length - 1] = '(' + multiReg[multiReg.length - 1] + '\\n?)+';
                        }
                        const out = multiReg.map(element => RegExp(element));
                        const result = { index: counter, document: document, regex: RegExp(multiReg.join('\\n')), range: new vscode.Range(locationOfRegex[counter], 0, locationOfRegex[counter], document.lineAt(locationOfRegex[counter]).text.length), group: out };
                        if (result) {
                            matches.push(result);
                            line.push(extractGroups(mult));
                        }
                    }
                }
                problemsCollection.push(line);
                counter++
            }
        }
        return matches;
    }

    function extractGroups(problemMatcherInstance: any[]) {
        const validProperties = ['line', 'column', 'severity', 'code', 'file', 'location', 'endColumn', 'endLine', 'message'];
        let data: any = {};
        let counterOfGroups = 0;
        let diagnosticInfo = {};
        for (let j = 0; j < problemMatcherInstance.length; ++j) {
            let tmp: any = {};
            for (let c in validProperties) {
                if (problemMatcherInstance[j][validProperties[c]] && (!data[j] || !data[j][validProperties[c]])) {
                    tmp[validProperties[c]] = problemMatcherInstance[j][validProperties[c]]
                }
            }
            data[j] = tmp
        }
        return data;
    }

    function getRegexRegex(flag: boolean) {
        if (flag) return regexRegex;
        return multiRegexRegex;
    }

    function createRegexMatch(document: vscode.TextDocument, line: number, match: RegExpExecArray, index: number) {
        const regex = createRegex(match[index]);
        if (regex) {
            return {
                document: document,
                regex: regex,
                range: new vscode.Range(line, match.index, line, match.index + match[0].length + match[1].length + match[index].length)
            };
        }
    }

    function createRegex(pattern: string) {
        try {
            return new RegExp(pattern);
        } catch (e) {
            // discard
        }
    }

    function findMatches(regexMatch: RegexMatch, document: vscode.TextDocument) {
        const text = document.getText();
        const matches: Match[] = [];
        const regex = addGM(regexMatch.regex);
        let match: RegExpExecArray | null;
        let toAdd: vscode.Diagnostic[] = [];
        let mapping = '';
        if (!regexMatch.index) {
            regexMatch.index = 0;
        }
        while ((regex.global || !matches.length) && (match = regex.exec(text))) {
            let message: string | null = null;
            let file: string | null = null;
            let range: vscode.Range | null = null;
            if (!mapping) {
                if (!regexMatch.group) {
                    regexMatch.group = [regexMatch.regex];
                }
                mapping = computeGroupNumbers(match[0], regexMatch.group, regexMatch.index);
            }
            matches.push({
                range: new vscode.Range(document.positionAt(match.index), document.positionAt(match.index + match[0].length))
            });
            let a: vscode.Diagnostic[] = [];

            if (regexMatch.group) {
                a = mapGroups(match, regexMatch, regexMatch.index, mapping);
            } else {
                regexMatch.group = [regexMatch.regex]
                const mapping = computeGroupNumbers(match[0], regexMatch.group, regexMatch.index);
                a = mapGroups(match, regexMatch, regexMatch.index, mapping);
            }

            for (let i = 0; i < a.length; ++i) {
                toAdd.push(a[i]);
            }

            // Handle empty matches (fixes #4)
            if (regex.lastIndex === match.index) {
                regex.lastIndex++;
            }
        }
        if (editor) {
            // send to problems
            diagnosticCollection.set(editor.document.uri, toAdd);
        }
        return matches;
    }

    function mapGroups(match: RegExpExecArray, regexes: RegexMatch, counter: number, mapping: any): vscode.Diagnostic[] {
        let matchLines = match;
        const regexLines = regexes.group;
        let pro: vscode.Diagnostic[] = [];
        if (regexLines) {
            let mapped: vscode.Diagnostic;
            problemsCollection;
            let range: vscode.Range = new vscode.Range(0, 0, 0, 0);
            let message: string = '';
            let source: string = '';
            let code: string | number = '';
            let flag: boolean = false;
            let severity: vscode.DiagnosticSeverity = vscode.DiagnosticSeverity.Error;
            try {
                code = matchLines[mapping['code']];
                source = matchLines[mapping['file']];
                message = matchLines[mapping['message']];
                if (mapping['severity'] !== -1 && matchLines.length > mapping['severity']) {
                    if (matchLines[mapping['severity']].toLowerCase() === 'warning') {
                        severity = vscode.DiagnosticSeverity.Warning;
                    }
                    if (matchLines[mapping['severity']].toLowerCase() === 'error') {
                        severity = vscode.DiagnosticSeverity.Error;
                    }
                    if (matchLines[mapping['severity']].toLowerCase() === 'info') {
                        severity = vscode.DiagnosticSeverity.Information;
                    }
                    if (matchLines[mapping['severity']].toLowerCase() === 'hint') {
                        severity = vscode.DiagnosticSeverity.Hint;
                    }
                }
                if (mapping['location'] > -1 && matchLines.length > mapping['location']) {
                    let a = matchLines[mapping['location']].split(',');
                    let b = a.map(element => Number.parseInt(element));
                    if (a.length === 1) {
                        range = new vscode.Range(b[0], 0, b[0], 0);
                        flag = true;
                    } else if (a.length === 2) {
                        range = new vscode.Range(b[0], b[1], b[0], b[1]);
                        flag = true;
                    } else if (a.length === 4) {
                        range = new vscode.Range(b[0], b[1], b[3], b[4]);
                        flag = true;
                    }
                } else {
                    // make a range from columns
                    let endl = matchLines[mapping['endline']];
                    let endc = matchLines[mapping['endcolumn']];
                    if (!endl) {
                        endl = matchLines[mapping['line']];
                    }
                    if (!endc) {
                        endc = matchLines[mapping['column']]
                    }
                    range = new vscode.Range(Number.parseInt(matchLines[mapping['line']]), Number.parseInt(matchLines[mapping['column']]),
                        Number.parseInt(endl), Number.parseInt(endc));
                }
            } catch (ex) {
                // console.log(ex);
            }
            if (message && source && flag) {
                if (!code) {
                    code = 'a' + Math.random().toString();
                }
                pro.push({ source: source, range: range, message: message, code: code, severity: severity });
            }
        }

        return pro;
    }

    function computeGroupNumbers(match: string, regexes: RegExp[], aaaa: number) {
        const validProperties = ['line', 'column', 'severity', 'code', 'file', 'location', 'endColumn', 'endLine', 'message'];
        let counter = 0;
        let flag = false;
        let a: any = { 'line': 1, 'column': 3, 'severity': -1, 'code': -1, 'file': 1, 'location': -1, 'endColumn': -1, 'endLine': -1, 'message': 4 };
        for (let i = 0; i < regexes.length; ++i) {
            let h = problemsCollection[aaaa][0];
            for (let j = 0; j < validProperties.length; ++j) {
                if (h[i][validProperties[j]]) {
                    if (validProperties[j] === 'location' && !flag) {
                        a['message'] = 5;
                    }
                    if (validProperties[j] === 'message') {
                        flag = true;
                    }
                    a[validProperties[j]] = h[i][validProperties[j]] + counter;
                }
            }
            regexes[i] = RegExp(regexes[i].source.replace(/^\^/, ''));
            regexes[i] = RegExp(regexes[i].source.replace(/\$$/, ''));
            let groupings = regexes[i].exec(match);
            if (groupings) {
                counter += groupings.length - 1;
            }
        }
        return a;
    }
}
