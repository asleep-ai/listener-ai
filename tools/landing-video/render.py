"""Edit actual app video and held genuine UI frames; never render substitute UI."""
from pathlib import Path
import os
import subprocess

root = Path(__file__).resolve().parents[2]
data = Path(os.environ['LISTENER_DEMO_DATA'])
if not data.is_absolute():
    raise ValueError('LISTENER_DEMO_DATA must be absolute')
out = root / 'docs/assets/demos'
font = '/System/Library/Fonts/Supplemental/Arial.ttf'
bold = '/System/Library/Fonts/Supplemental/Arial Bold.ttf'
clips = [
    ('video', data/'raw-video/page@cc4798ee05a8a0d4b85b9c5355e96015.webm', 4, 6, '01  IMPORT A REAL MEETING'),
    ('video', data/'raw-video/page@cd1be0ededc6d82c1d78213ef115d200.webm', 6.5, 10.3, '02  READ THE SAVED REPORT'),
    ('image', data/'06-transcript.png', 0, 2.7, '03  REVIEW THE SPEAKER TRANSCRIPT'),
    ('video', data/'raw-video/page@cd1be0ededc6d82c1d78213ef115d200.webm', 17.7, 8.1, '04  ASK ABOUT THIS MEETING'),
    ('image', data/'07-ask.png', 0, 2, '04  ANSWERS GROUNDED IN THE MEETING'),
]
paths=[]
for i,(kind,src,start,length,label) in enumerate(clips):
    p=data/f'edit-{i}.mp4';paths.append(p)
    args=['ffmpeg','-y','-hide_banner','-loglevel','error']
    if kind=='image':args+=['-loop','1','-i',str(src)]
    else:args+=['-ss',str(start),'-i',str(src)]
    crop='crop=1280:868:0:0,' if kind=='video' else ''
    vf=(crop+'scale=1280:868,pad=1440:1080:80:106:color=0x0b1626,'
        f"drawtext=fontfile='{bold}':text='Listener.AI':fontcolor=white:fontsize=31:x=80:y=43,"
        f"drawtext=fontfile='{font}':text='FROM MEETING AUDIO TO ANSWERS':fontcolor=0x91b9df:fontsize=18:x=850:y=53,"
        f"drawtext=fontfile='{bold}':text='{label}':fontcolor=white:fontsize=23:x=80:y=997,"
        f"drawtext=fontfile='{font}':text='Actual app capture  |  Processing waits removed  |  AMI Corpus CC BY 4.0':fontcolor=0xa5b7ca:fontsize=17:x=80:y=1040")
    subprocess.run(args+['-t',str(length),'-vf',vf,'-r','30','-c:v','libx264','-crf','19','-preset','medium','-pix_fmt','yuv420p','-an',str(p)],check=True)
concat=data/'concat.txt';concat.write_text(''.join(f"file '{p}'\n" for p in paths))
subprocess.run(['ffmpeg','-y','-hide_banner','-loglevel','error','-f','concat','-safe','0','-i',str(concat),'-c','copy','-movflags','+faststart',str(out/'listener-demo.mp4')],check=True)
subprocess.run(['ffmpeg','-y','-hide_banner','-loglevel','error','-ss','12','-i',str(out/'listener-demo.mp4'),'-frames:v','1','-q:v','2',str(out/'listener-demo.jpg')],check=True)
