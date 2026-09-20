#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成硬盘标签 PNG（A4 竖版，一页一张，字大适合贴盘）
用法: make_label.py <输出.png> <json数据文件>
数据字段: device, model, serial, brand, interface, lun, capacity, status, extra, date
"""
import sys, json, os

def main():
    if len(sys.argv) < 3:
        print("usage: make_label.py out.png data.json"); return 2
    out, datafile = sys.argv[1], sys.argv[2]
    d = json.load(open(datafile, encoding='utf-8'))
    try:
        from PIL import Image, ImageDraw, ImageFont
    except Exception as e:
        print("NO_PIL: %s" % e); return 3

    W, H = 1240, 1754           # A4 @150dpi
    img = Image.new('RGB', (W, H), 'white')
    dr = ImageDraw.Draw(img)

    def font(sz, bold=False):
        cands = []
        if bold:
            cands += ['/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc',
                      '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
                      '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc']
        cands += ['/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
                  '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
                  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf']
        for c in cands:
            if os.path.exists(c):
                try:
                    return ImageFont.truetype(c, sz)
                except Exception:
                    pass
        return ImageFont.load_default()

    f_title = font(58, True)
    f_big   = font(96, True)
    f_mid   = font(52)
    f_lab   = font(34)
    f_small = font(28)

    M = 70
    dr.rectangle([30, 30, W - 30, H - 30], outline='black', width=6)
    dr.rectangle([M - 20, M - 20, W - M + 20, M + 105], fill='black')
    dr.text((M, M + 12), '硬 盘 标 签', font=f_title, fill='white')

    y = M + 190
    dr.text((M, y), '序列号 SN', font=f_lab, fill='#555555')
    y += 46
    sn = str(d.get('serial') or '-')
    dr.text((M, y), sn, font=f_big, fill='black')
    y += 130
    dr.line([M, y, W - M, y], fill='#bbbbbb', width=4)
    y += 40

    rows = [
        ('型号', d.get('model') or '-'),
        ('品牌', d.get('brand') or '-'),
        ('接口', d.get('interface') or '-'),
        ('容量', d.get('capacity') or '-'),
        ('逻辑块', str(d.get('lun') or '-') + ' B' if d.get('lun') else '-'),
        ('状态', d.get('status') or '-'),
        ('设备', d.get('device') or '-'),
        ('日期', d.get('date') or ''),
    ]
    for k, v in rows:
        dr.text((M, y), k, font=f_lab, fill='#666666')
        dr.text((M + 220, y - 6), str(v), font=f_mid, fill='black')
        y += 74

    extra = d.get('extra') or ''
    if extra:
        y += 10
        dr.text((M, y), extra, font=f_small, fill='#444444')

    dr.text((M, H - 120), 'disk-webui V0.2', font=f_small, fill='#999999')
    img.save(out)
    print('OK ' + out)
    return 0

if __name__ == '__main__':
    sys.exit(main())
