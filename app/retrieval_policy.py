"""Per-run retrieval methods; absent outside unified evaluation."""

from contextlib import contextmanager
from contextvars import ContextVar

_methods = ContextVar("retrieval_methods", default=None)
_scope = ContextVar("retrieval_scope", default=None)
_versions = ContextVar("retrieval_graph_versions", default=None)


def selected_methods():
    return _methods.get()


def selected_scope():
    return _scope.get()


def selected_graph_versions():
    return _versions.get()


@contextmanager
def use_methods(methods, scope=None, graph_versions=None):
    token = _methods.set(tuple(methods) if methods is not None else None)
    scope_token = _scope.set(scope)
    versions_token = _versions.set(
        tuple(graph_versions) if graph_versions is not None else None
    )
    try:
        yield
    finally:
        _methods.reset(token)
        _scope.reset(scope_token)
        _versions.reset(versions_token)
