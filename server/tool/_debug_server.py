from pygls.server import LanguageServer
from pygls import workspace
import lsprotocol.types as lsp
import unginxed
from unginxed.signature import Signature

server = LanguageServer('unginxed', 'v0.1')

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


def _convert_to_diagnostics(result: Signature) -> list[lsp.Diagnostic]:
    '''
    Converts a all lines flagged in a uNGINXed Signature to a list of LSP Diagnostics
    '''
    diagnostics = []
    for flagged in result.flagged:
        start = lsp.Position(line=flagged.line, character=flagged.column_start)
        end = lsp.Position(line=flagged.line, character=flagged.column_end)
        diagnostic = lsp.Diagnostic(
            range=lsp.Range(start=start, end=end),
            message=result.name,
            severity=lsp.DiagnosticSeverity.Error,
            source='uNGINXed',
            related_information=result.description
        )
        diagnostics.append(diagnostic)
    return diagnostics


def _linting_helper2(document: workspace.Document) -> list[lsp.Diagnostic]:
    diagnostics = []
    try:
        results = unginxed.scan(document.uri)
        for result in results: 
            diagnostics.extend(_convert_to_diagnostics(result))
    except Exception as e:
        server.show_message_log(f'Linting failed with exception {e}', lsp.MessageType.Error)
    return diagnostics


def _linting_helper(document: workspace.Document) -> list[lsp.Diagnostic]:
    diagnostics = []
    try:
        start = lsp.Position(line=0, character=0)
        end = lsp.Position(line=0, character=10)
        diagnostic = lsp.Diagnostic(
            range=lsp.Range(start=start, end=end),
            message='test',
            severity=lsp.DiagnosticSeverity.Error
        )
        diagnostics.append(diagnostic)
    except Exception as e:
        server.show_message_log(f'Linting failed with exception {e}', lsp.MessageType.Error)
    return diagnostics

if __name__ == '__main__':
    server.start_io()