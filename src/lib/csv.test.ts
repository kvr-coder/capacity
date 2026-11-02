import { describe, expect, it } from 'vitest'

import { csvField, parseCsv, parseCsvRows, toCsv } from '@/lib/csv'

describe('parseCsv', () => {
  it('returns nothing for empty input', () => {
    expect(parseCsv('')).toEqual([])
  })

  it('parses a plain table', () => {
    expect(parseCsv('a,b,c\n1,2,3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ])
  })

  it('does not invent a row for a trailing newline', () => {
    expect(parseCsv('a,b\n1,2\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  it('handles CRLF, and mixed endings within one file', () => {
    expect(parseCsv('a,b\r\n1,2\r\n3,4\n5,6\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
      ['3', '4'],
      ['5', '6'],
    ])
  })

  it('keeps commas inside quoted fields', () => {
    expect(parseCsv('a,"b,c",d')).toEqual([['a', 'b,c', 'd']])
  })

  it('keeps newlines inside quoted fields', () => {
    expect(parseCsv('a,"line1\nline2",c\nx,y,z')).toEqual([
      ['a', 'line1\nline2', 'c'],
      ['x', 'y', 'z'],
    ])
  })

  it('keeps CRLF inside quoted fields without splitting the record', () => {
    expect(parseCsv('a,"one\r\ntwo"\r\nb,c\r\n')).toEqual([
      ['a', 'one\r\ntwo'],
      ['b', 'c'],
    ])
  })

  it('unescapes doubled double-quotes', () => {
    expect(parseCsv('"he said ""hi""",2')).toEqual([['he said "hi"', '2']])
  })

  it('unescapes a run of doubled quotes', () => {
    expect(parseCsv('"""""",x')).toEqual([['""', 'x']])
  })

  it('treats a field that is exactly "" as empty', () => {
    expect(parseCsv('a,"",c')).toEqual([['a', '', 'c']])
    expect(parseCsv('""')).toEqual([['']])
  })

  it('keeps empty fields, including a trailing one', () => {
    expect(parseCsv('a,,c\n,,\nx,y,')).toEqual([
      ['a', '', 'c'],
      ['', '', ''],
      ['x', 'y', ''],
    ])
  })

  it('strips a leading BOM from the first field only', () => {
    expect(parseCsv('﻿MATNR,WERKS\nM1,P1')).toEqual([
      ['MATNR', 'WERKS'],
      ['M1', 'P1'],
    ])
  })

  it('does not trim padding — SAP pads fields and that is data', () => {
    expect(parseCsv('  a  ,b')).toEqual([['  a  ', 'b']])
  })

  it('recovers from an unterminated quote at EOF', () => {
    expect(parseCsv('a,"broken')).toEqual([['a', 'broken']])
  })

  it('absorbs junk after a closing quote instead of losing the row', () => {
    expect(parseCsv('"a"b,c')).toEqual([['ab', 'c']])
  })

  it('reports 1-based physical record numbers, header included', () => {
    const seen: Array<{ n: number; first: string }> = []
    parseCsvRows('h\n"multi\nline"\nlast\n', (cells, n) => {
      seen.push({ n, first: cells[0] ?? '' })
    })
    expect(seen).toEqual([
      { n: 1, first: 'h' },
      { n: 2, first: 'multi\nline' },
      { n: 3, first: 'last' },
    ])
  })
})

describe('toCsv', () => {
  it('quotes only what needs quoting', () => {
    expect(csvField('plain')).toBe('plain')
    expect(csvField('a,b')).toBe('"a,b"')
    expect(csvField('a"b')).toBe('"a""b"')
    expect(csvField('a\nb')).toBe('"a\nb"')
    expect(csvField(12.5)).toBe('12.5')
  })

  it('emits a trailing newline and stringifies numbers', () => {
    expect(toCsv([['a', 'b'], [1, 2.5]])).toBe('a,b\n1,2.5\n')
  })

  it('round-trips awkward values', () => {
    const rows = [
      ['MATNR', 'TEXT'],
      ['M-1', 'comma, inside'],
      ['M-2', 'quote " inside'],
      ['M-3', 'newline\ninside'],
      ['M-4', ''],
      ['M-5', '  padded  '],
    ]
    expect(parseCsv(toCsv(rows))).toEqual(rows)
  })

  it('round-trips a value that is only quotes', () => {
    expect(parseCsv(toCsv([['""', '"']]))).toEqual([['""', '"']])
  })
})
