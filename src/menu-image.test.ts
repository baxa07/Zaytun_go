import{describe,expect,it}from'vitest';
import{MENU_IMAGE_MAX_BYTES,validateMenuImageFile}from'./domain';

const candidate=(type:string,size=1024)=>({type,size} as File);

describe('Owner menu image validation',()=>{
  it.each(['image/jpeg','image/png','image/webp'])('accepts %s',type=>expect(validateMenuImageFile(candidate(type))).toBeNull());
  it('rejects non-images and unsupported HEIC clearly',()=>{
    expect(validateMenuImageFile(candidate('text/plain'))).toMatch(/JPG, PNG yoki WebP/);
    expect(validateMenuImageFile(candidate('image/heic'))).toMatch(/JPG, PNG yoki WebP/);
  });
  it('rejects empty and oversized files',()=>{
    expect(validateMenuImageFile(candidate('image/jpeg',0))).toMatch(/bo‘sh/);
    expect(validateMenuImageFile(candidate('image/jpeg',MENU_IMAGE_MAX_BYTES+1))).toMatch(/8 MB/);
  });
});
