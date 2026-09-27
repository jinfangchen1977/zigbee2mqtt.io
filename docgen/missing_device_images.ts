import {checkFileExists, getImage, allDefinitions} from './utils';
import {imageBaseDir} from './constants';
import * as path from 'path';
import * as fs from 'fs';
import * as gis from 'async-g-i-s';
import {execFileSync} from 'child_process';

const missingImagesPath = path.join(__dirname, 'missing-device-images');

// ImageMagick 7 ships a single `magick` binary, ImageMagick 6 separate `convert`/`identify` binaries
let hasMagickBinary: boolean | undefined;
function imageMagick(command: 'convert' | 'identify', args: string[]): string {
    if (hasMagickBinary === undefined) {
        try {
            hasMagickBinary = /ImageMagick/.test(execFileSync('magick', ['-version'], {encoding: 'utf8'}));
        } catch {
            hasMagickBinary = false;
        }
    }
    return hasMagickBinary ? execFileSync('magick', [command, ...args], {encoding: 'utf8'}) : execFileSync(command, args, {encoding: 'utf8'});
}

function imageInfo(imagePath: string): {width: number; height: number} {
    // `[0]` = first frame, in case of animated images
    const [width, height] = imageMagick('identify', ['-format', '%w %h', `${imagePath}[0]`])
        .trim()
        .split(' ')
        .map(Number);
    return {width, height};
}

export async function getMissing(): Promise<{image: string; model: string; vendor: string}[]> {
    const missing: any[] = [];
    await Promise.all(
        allDefinitions.map(async (device) => {
            const image = path.join(imageBaseDir, await getImage(device, imageBaseDir, ''));
            if (!(await checkFileExists(image))) {
                missing.push({...device, image});
            }
        }),
    );

    return missing;
}

export async function downloadImage(url: string, path: string) {
    // No shell: the url comes from image search results
    execFileSync('curl', [url, '-o', path]);
    if (!fs.existsSync(path)) {
        throw new Error('failed');
    }
}

export async function ensurePngWithoutBackground(imagePath: string) {
    if (path.parse(imagePath).ext !== '.png') {
        const imagePathPng = `${path.join(missingImagesPath, path.parse(imagePath).name)}.png`;
        imageMagick('convert', [imagePath, '-auto-orient', imagePathPng]);
        fs.rmSync(imagePath);
        imagePath = imagePathPng;
    }
    // execSync(`transparent-background --source ${imagePath} --dest ${path.parse(imagePath).dir}`);
    return imagePath;
}

export async function downloadMissing() {
    // if (fs.existsSync(missingImagesPath)) {
    //     fs.rmSync(missingImagesPath, {recursive: true});
    // }
    // fs.mkdirSync(missingImagesPath);

    const missing = await getMissing();
    for (const definition of missing) {
        const query = `${definition.model} ${definition.vendor}`;
        console.log(`Querying '${query}'`);
        // @ts-expect-error
        const images: {url: string}[] = (await gis(`${definition.model} ${definition.vendor}`))
            .filter((r) => r.url.endsWith('.webp') || r.url.endsWith('.jpg') || r.url.endsWith('.jpeg') || r.url.endsWith('.png'))
            .slice(0, 5);
        for (const image of images) {
            let imagePath = path.join(
                missingImagesPath,
                `${path.parse(path.basename(definition.image)).name}_${images.indexOf(image)}${path.extname(image.url)}`,
            );
            try {
                // Download
                await downloadImage(image.url, imagePath);

                // Make square
                const info = imageInfo(imagePath);
                if (info.height !== info.width) {
                    const size = Math.max(info.height, info.width);
                    imageMagick('convert', [imagePath, '-resize', `${size}x${size}`, '-gravity', 'center', '-extent', `${size}x${size}`, imagePath]);
                }

                // Convert to png
                imagePath = await ensurePngWithoutBackground(imagePath);
            } catch (error) {
                console.error(`Failed to handle '${imagePath}' (${error}), removing...`);
                if (fs.existsSync(imagePath)) fs.rmSync(imagePath);
            }
        }
    }

    console.log(`Done! Filter and update all the files under '${missingImagesPath}', execute 'npm run move-missing-device-images'`);
}

export async function prepareMissing() {
    for (const file of fs.readdirSync(missingImagesPath)) {
        let imagePath = path.join(missingImagesPath, file);

        try {
            // Make square
            const info = imageInfo(imagePath);
            if (info.height !== info.width) {
                const size = Math.max(info.height, info.width);
                imageMagick('convert', [imagePath, '-resize', `${size}x${size}`, '-gravity', 'center', '-extent', `${size}x${size}`, imagePath]);
            }

            // Convert to png
            imagePath = await ensurePngWithoutBackground(imagePath);
        } catch (error) {
            console.error(`Failed to handle '${imagePath}' (${error}), removing...`);
            if (fs.existsSync(imagePath)) fs.rmSync(imagePath);
        }
    }
    console.log(`Done! Filter and update all the files under '${missingImagesPath}', execute 'npm run move-missing-device-images'`);
}

async function moveMissing() {
    for (const file of fs.readdirSync(missingImagesPath)) {
        try {
            let source = path.join(missingImagesPath, file);
            // source = await ensurePngWithoutBackground(source);
            const name = path.basename(source);
            const match = name.match('(.+)_\\d+\\.png');
            if (!match) throw new Error(`Failed to match '${name}'`);
            const target = path.join(imageBaseDir, `${match[1]}.png`);
            fs.copyFileSync(source, target);
            const info = imageInfo(target);
            if (info.height !== info.width) {
                throw new Error(`${file} is not a square`);
            }
            const size = info.height >= 512 ? 512 : 150;
            imageMagick('convert', [target, '-auto-orient', '-resize', `${size}x${size}`, target]);
        } catch (error) {
            console.error(`Failed to handle '${file}' (${error})`);
        }
    }
    console.log('Done!');
}

if (require.main === module) {
    (async function () {
        const arg = process.argv[process.argv.length - 1];
        if (arg === 'download') {
            await downloadMissing();
        } else if (arg === 'prepare') {
            await prepareMissing();
        } else if (arg === 'move') {
            await moveMissing();
        } else {
            throw new Error(`Unsupported option ${arg}`);
        }
    })();
}
