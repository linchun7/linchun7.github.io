"""Validate this project's generated HTML; not an HTML5 sanitizer."""
import json
import re
import sys
from html.parser import HTMLParser
from decimal import Decimal

VOID = frozenset('area base br col embed hr img input link meta param source track wbr'.split())
INERT = frozenset('template noscript script style textarea title iframe xmp noembed noframes plaintext svg math'.split())
ROOT_IDS = (
    'updatedAt', 'freshnessWarning', 'minimumSummary', 'minimumHistoryButton',
    'marketCount', 'currencyCount', 'planCount', 'priceWorkspace',
    'historyDialog', 'backToTableButton',
)

class Element:
    def __init__(self, tag, attrs, parent=None):
        self.tag, self.attrs, self.parent = tag, dict(attrs), parent
        self.children = []

class Document(HTMLParser):
    def __init__(self, source):
        super().__init__(convert_charrefs=True)
        self.root = Element('#document', [])
        self.stack = [self.root]
        self.ids = {}
        self.bodies = []
        self.feed(source)
        self.close()
        if len(self.stack) != 1:
            raise ValueError('unclosed HTML element: ' + self.stack[-1].tag)
        if len(self.bodies) != 1 or self.bodies[0].parent.tag != 'html':
            raise ValueError('expected one real HTML body')

    def handle_starttag(self, tag, attrs):
        names = [name for name, _ in attrs]
        if len(set(names)) != len(names):
            raise ValueError('duplicate HTML attribute')
        node = Element(tag, attrs, self.stack[-1])
        self.stack[-1].children.append(node)
        identifier = node.attrs.get('id')
        if identifier:
            self.ids.setdefault(identifier, []).append(node)
        if tag == 'body':
            self.bodies.append(node)
        if tag not in VOID:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        if tag not in VOID:
            raise ValueError('self-closing non-void HTML element')
        self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag):
        if tag in VOID or len(self.stack) == 1 or self.stack[-1].tag != tag:
            raise ValueError('unbalanced HTML end tag: ' + tag)
        self.stack.pop()

    def handle_data(self, value):
        children = self.stack[-1].children
        if children and isinstance(children[-1], str):
            children[-1] += value
        else:
            children.append(value)

    def required(self, identifier):
        found = self.ids.get(identifier, [])
        if len(found) != 1:
            raise ValueError('missing or duplicate required ID: ' + identifier)
        node = found[0]
        ancestor, in_body = node.parent, False
        while ancestor:
            if ancestor.tag in INERT:
                raise ValueError('required ID is in inactive HTML: ' + identifier)
            in_body = in_body or ancestor is self.bodies[0]
            ancestor = ancestor.parent
        if not in_body:
            raise ValueError('required ID is outside the body: ' + identifier)
        return node

def attributes(node):
    result = []
    for key, value in sorted(node.attrs.items()):
        value = '' if value is None else value
        if key == 'class':
            value = ' '.join(sorted(value.split()))
        elif key == 'style':
            value = re.sub(r'\s*([:;])\s*', r'\1', value.strip()).rstrip(';')
        result.append((key, value))
    return result

def projection(node):
    children = []
    for child in node.children:
        if isinstance(child, str):
            value = re.sub(r'\s+', ' ', child).strip()
            if value:
                children.append(value)
        else:
            children.append(projection(child))
    return [node.tag, attributes(node), children]

def ancestors(node):
    result = []
    node = node.parent
    while node and node.tag != '#document':
        result.append([node.tag, attributes(node)])
        node = node.parent
    return result

def identifiers(node):
    result = [node.attrs['id']] if node.attrs.get('id') else []
    for child in node.children:
        if isinstance(child, Element):
            result.extend(identifiers(child))
    return result

def no_duplicate_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate JSON key: ' + key)
        result[key] = value
    return result

def reject_constant(value):
    raise ValueError('non-finite JSON number')

def equal_json(left, right):
    # JSON number spellings such as 1 and 1.0 are equivalent, but true is not 1.
    if isinstance(left, bool) or isinstance(right, bool):
        return type(left) is type(right) and left == right
    if isinstance(left, dict) and isinstance(right, dict):
        return left.keys() == right.keys() and all(equal_json(left[key], right[key]) for key in left)
    if isinstance(left, list) and isinstance(right, list):
        return len(left) == len(right) and all(equal_json(a, b) for a, b in zip(left, right))
    if isinstance(left, (int, float, Decimal)) and isinstance(right, (int, float, Decimal)):
        return Decimal(str(left)) == Decimal(str(right))
    return type(left) is type(right) and left == right

def embedded(document, expected_data):
    node = document.required('price-data')
    if node.tag != 'script' or (node.attrs.get('type') or '').strip().lower() != 'application/json':
        raise ValueError('price-data is not an application/json script')
    if any(not isinstance(child, str) for child in node.children):
        raise ValueError('price-data contains HTML nodes')
    value = json.loads(''.join(node.children), object_pairs_hook=no_duplicate_keys, parse_float=Decimal, parse_constant=reject_constant)
    if not equal_json(value, expected_data):
        raise ValueError('embedded price-data does not equal expected snapshot')
    return node

def elements(node):
    yield node
    for child in node.children:
        if isinstance(child, Element):
            yield from elements(child)

def validate_assets(expected, actual):
    definitions = (
        ('script', 'src', 'app.js?v=', ('src', 'type', 'defer', 'async', 'nomodule', 'integrity', 'crossorigin')),
        ('link', 'href', 'style.css?v=', ('href', 'rel', 'media', 'disabled', 'type', 'integrity', 'crossorigin')),
        ('link', 'href', 'vendor/lucide-subset.js?v=', ('href', 'rel', 'as', 'type', 'integrity', 'crossorigin')),
    )
    for tag, attribute, prefix, keys in definitions:
        wanted = [node for node in elements(expected.root)
                  if node.tag == tag and (node.attrs.get(attribute) or '').startswith(prefix)]
        if len(wanted) != 1:
            raise ValueError('expected HTML asset element missing or duplicated: ' + prefix)
        wanted = wanted[0]
        found = [node for node in elements(actual.root)
                 if node.tag == tag and node.attrs.get(attribute) == wanted.attrs[attribute]]
        if len(found) != 1 or wanted.parent.tag != 'head':
            raise ValueError('HTML asset element missing or duplicated: ' + prefix)
        received = found[0]
        contract = lambda node: [(key, key in node.attrs, node.attrs.get(key) or '') for key in keys]
        if ancestors(received) != ancestors(wanted) or contract(received) != contract(wanted):
            raise ValueError('HTML asset element differs from expected: ' + prefix)

def validate_html(expected_html, actual_html, expected_data):
    expected, actual = Document(expected_html), Document(actual_html)
    validate_assets(expected, actual)
    expected_data_node = embedded(expected, expected_data)
    actual_data_node = embedded(actual, expected_data)
    if ancestors(actual_data_node) != ancestors(expected_data_node):
        raise ValueError('embedded price-data moved outside its expected scaffold')
    for identifier in ROOT_IDS:
        wanted, received = expected.required(identifier), actual.required(identifier)
        for required_id in identifiers(wanted):
            actual.required(required_id)
        if ancestors(received) != ancestors(wanted) or projection(received) != projection(wanted):
            raise ValueError('application HTML differs from expected: ' + identifier)

if __name__ == '__main__':
    try:
        payload = json.load(sys.stdin, object_pairs_hook=no_duplicate_keys, parse_float=Decimal, parse_constant=reject_constant)
        validate_html(payload['expected_html'], payload['actual_html'], payload['expected_data'])
    except (ValueError, TypeError, KeyError, RecursionError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
