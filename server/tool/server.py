from pygls.server import LanguageServer
from pygls import workspace
import lsprotocol.types as lsp
from pathlib import Path
from os import path
import sys

sys.path.append(path.join(sys.path[0], '..', '..', 'uNGINXed'))
import unginxed

server = LanguageServer('unginxed', 'v0.1')

severity_mapping = {
    unginxed.signature.Severity.INFORMATION: lsp.DiagnosticSeverity.Information,
    unginxed.signature.Severity.WARNING: lsp.DiagnosticSeverity.Warning,
    unginxed.signature.Severity.ERROR: lsp.DiagnosticSeverity.Error
}

@server.feature(lsp.TEXT_DOCUMENT_DID_OPEN)
def did_open(param: lsp.DidOpenTextDocumentParams)-> None:
    document = server.workspace.get_document(param.text_document.uri)
    diagnostics: list[lsp.Diagnostic] = _linting_helper(document)
    server.publish_diagnostics(document.uri, diagnostics)


@server.feature(lsp.TEXT_DOCUMENT_DID_SAVE)
def did_save(param: lsp.DidOpenTextDocumentParams) -> None:
    document = server.workspace.get_document(param.text_document.uri)
    diagnostics: list[lsp.Diagnostic] = _linting_helper(document)
    server.publish_diagnostics(document.uri, diagnostics)


@server.feature(lsp.TEXT_DOCUMENT_DID_CLOSE)
def did_close(param: lsp.DidOpenTextDocumentParams) -> None:
    document = server.workspace.get_document(param.text_document.uri)
    server.publish_diagnostics(document.uri, [])

def _convert_to_diagnostics(result: unginxed.Signature) -> list[lsp.Diagnostic]:
    '''
    Converts a all lines flagged in a uNGINXed Signature to a list of LSP Diagnostics
    '''
    diagnostics = []
    for flagged in result.flagged:
        start = lsp.Position(line=flagged["line"] - 1, character=flagged["column_start"] - 1)
        end = lsp.Position(line=flagged["line"] - 1, character=flagged["column_end"] - 1)
        diagnostic = lsp.Diagnostic(
            range=lsp.Range(start=start, end=end),
            message=result.description,
            severity=severity_mapping[result.severity],
            source=result.name
        )
        diagnostics.append(diagnostic)
    return diagnostics


def _linting_helper(document: workspace.Document) -> list[lsp.Diagnostic]:
    diagnostics = []
    try:
        results = unginxed.scan(document.path)
        for result in results: 
            diagnostics.extend(_convert_to_diagnostics(result))
    except Exception as e:
        server.show_message_log(f'Linting failed with exception {e}', lsp.MessageType.Error)
    return diagnostics


def log(string: str):
    Path('logs').mkdir(exist_ok=True)
    with open(f'logs/logs.txt', 'a+') as f:
        f.write(string)
        f.write('\n')


if __name__ == '__main__':
    server.start_io()
